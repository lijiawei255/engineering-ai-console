/**
 * 配置状态：服务端模式走同源 /api/*，纯静态直连模式用 localStorage 主备双槽位。
 *
 * 服务端模式下前端永远拿不到明文密钥，只持有掩码与 hasKey；
 * 密钥修改通过独立的 keys / clearKeys / customHeaders 字段提交，避免误覆盖。
 *
 * 保存路径按“单调编辑版本 + 串行队列”建模：
 * - 每次本地修改递增 editRevision；
 * - 所有写 /api/config 的请求排在同一条 promise 链上，避免两个请求互相覆盖；
 * - 请求返回时若 editRevision 已经变化，旧响应只允许更新密钥掩码与存储健康，
 *   不得覆盖内存里更新的 settings；随后继续保存最新版本；
 * - 发送聊天前 ensureConfigSynced 会取消防抖并等到 lastSavedRevision >= editRevision。
 */

import { create } from 'zustand'
import { showToast } from '../../components/base/toastState.js'
import {
  EMPTY_SECRET_MASKS,
  EMPTY_STORAGE_STATUS,
  createDefaultSettings,
  maskSecretWithFingerprint,
  sanitizeSecretMasks,
  sanitizeSettings,
  secretFingerprint,
  sanitizeStorageStatus,
  type AppSettings,
  type CapsuleId,
  type ChannelConfig,
  type ChannelSlot,
  type ConfigSnapshot,
  type ExaConfig,
  type HeaderPair,
  type HealthPayload,
  type Locale,
  type PromptSettings,
  type SecretMask,
  type SecretMasks,
  type StorageStatus,
  type UiSettings,
  type WatchdogSettings,
} from './types.js'

export type ConfigMode = 'server' | 'static'

export type SecretTarget = 'primary' | 'backup' | 'exa'

type SetCustomHeaders = (slot: ChannelSlot, pairs: HeaderPair[]) => Promise<void>
type RetryInit = () => Promise<void>

interface ConfigState {
  mode: ConfigMode
  ready: boolean
  /** http(s) 模式下本地服务不可达；不触发静态降级 */
  offline: boolean
  /** 初始化错误码：目前只有 'serverOffline'；null 表示正常 */
  initError: string | null
  serverToken: string
  settings: AppSettings
  secrets: SecretMasks
  storage: StorageStatus
  saving: boolean
  saveError: boolean
  /** 最近一次保存失败发生在哪一层：本地 localStorage('local') 还是本地服务端('server') */
  saveFailure: 'none' | 'local' | 'server'
  retryInit: RetryInit
  setCustomHeaders: SetCustomHeaders
}

const SETTINGS_KEY = 'eac:settings:v1'
const SETTINGS_BACKUP_KEY = 'eac:settings:v1.bak'
const HEALTH_TIMEOUT_MS = 2500
const CONFIG_TIMEOUT_MS = 8000
const SAVE_DEBOUNCE_MS = 350

const readStorage = (key: string): string | null => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const writeStorage = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {
    // 存储不可用时仅内存生效
  }
}

const removeStorage = (key: string) => {
  try {
    localStorage.removeItem(key)
  } catch {
    // 忽略
  }
}

const readServerToken = (): string => {
  const meta = document.querySelector('meta[name="console-session-token"]')
  return meta?.getAttribute('content')?.trim() ?? ''
}

const masksOf = (settings: AppSettings): SecretMasks => ({
  primary: maskSecretWithFingerprint(settings.channels.primary.apiKey),
  backup: maskSecretWithFingerprint(settings.channels.backup.apiKey),
  exa: maskSecretWithFingerprint(settings.exa.apiKey),
  // 静态模式下自定义 Header 值就在 settings 里，没有独立的掩码视图
  customHeaders: { primary: [], backup: [] },
})

export const useConfigStore = create<ConfigState>(() => ({
  mode: 'static',
  ready: false,
  offline: false,
  initError: null,
  serverToken: '',
  settings: createDefaultSettings(),
  secrets: EMPTY_SECRET_MASKS(),
  storage: EMPTY_STORAGE_STATUS(),
  saving: false,
  saveError: false,
  saveFailure: 'none',
  retryInit,
  setCustomHeaders,
}))

export const getSettings = (): AppSettings => useConfigStore.getState().settings

export const getActiveChannel = (): ChannelConfig => {
  const state = useConfigStore.getState()
  return state.settings.channels[state.settings.activeChannel]
}

export const getServerToken = (): string => useConfigStore.getState().serverToken

/**
 * 远端文件归属指纹里的凭据部分：实际生效密钥的单向短指纹。
 *
 * 服务端模式下直接使用 /api/config 用 resolve_api_key() 算出的结果——填了但未生效的
 * 环境变量名（envSet=false）不算凭据；纯静态模式下本地用同一套 sha256[:12] 计算。
 * 因此轮换真正生效的密钥会立即改变指纹，而不是被一个未生效的环境变量名掩盖。
 */
export const remoteKeyFingerprintOf = (slot: ChannelSlot): string => {
  const state = useConfigStore.getState()
  const direct = state.secrets[slot].keyFingerprint
  if (direct) {
    return direct
  }
  if (state.mode === 'static') {
    return secretFingerprint(state.settings.channels[slot].apiKey)
  }
  return 'none'
}

const serverFetch = async (path: string, init: RequestInit = {}): Promise<Response> => {
  const token = getServerToken()
  const headers = new Headers(init.headers)
  headers.set('X-Console-Token', token)
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  return fetch(path, { ...init, headers, cache: 'no-store' })
}

const readJson = async <T>(response: Response): Promise<T> => {
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`)
  }
  return JSON.parse(text) as T
}

// ---------------------------------------------------------------------------
// 编辑版本与串行保存队列
// ---------------------------------------------------------------------------

let editRevision = 0
let lastSavedRevision = 0
let saveTimer: ReturnType<typeof setTimeout> | undefined
let persistChain: Promise<void> = Promise.resolve()

/**
 * 凭据写请求的独立版本账本。
 *
 * setSecret / clearSecret / setCustomHeaders 不修改 settings，因此不会递增 editRevision；
 * 只等设置防抖链的 ensureConfigSynced 会在“刚轮换密钥、马上关闭弹窗上传 PDF”时立刻返回，
 * 结果是服务端按新密钥收文件、前端却用旧 keyFingerprint 记录附属归属。这里为凭据写请求
 * 单独记账：每次入队递增 secretRevision，响应真正应用后推进 secretAppliedRevision，
 * ensureConfigSynced 必须同时等到两个版本追平。
 */
let secretRevision = 0
let secretAppliedRevision = 0
let secretChain: Promise<void> = Promise.resolve()

/**
 * 尚未成功写入服务端的凭据变更意图账本。
 *
 * 文件锁 / 磁盘错误会让 /api/config 返回 500：此时凭据并没有落地，普通设置也已经
 * 可能没保存。若丢掉意图，用户以为改了密钥、后续上传却仍按旧凭据发请求。这里把
 * setSecret / clearSecret / setCustomHeaders 的意图合并保存：同槽位同字段后写覆盖先写、
 * set 与 clear 互斥；任何一次成功的服务端快照应用后才清掉对应字段，硬复位整体清空。
 */
interface CredentialPatch {
  keys: Partial<Record<SecretTarget, string>>
  clearKeys: Set<SecretTarget>
  customHeaders: Partial<Record<ChannelSlot, HeaderPair[]>>
}

const emptyCredentialPatch = (): CredentialPatch => ({
  keys: {},
  clearKeys: new Set(),
  customHeaders: {},
})

let pendingCredentialPatch: CredentialPatch = emptyCredentialPatch()

const hasPendingCredentialPatch = (): boolean =>
  Object.keys(pendingCredentialPatch.keys).length > 0 ||
  pendingCredentialPatch.clearKeys.size > 0 ||
  Object.keys(pendingCredentialPatch.customHeaders).length > 0

const snapshotCredentialPatch = (): CredentialPatch => ({
  keys: { ...pendingCredentialPatch.keys },
  clearKeys: new Set(pendingCredentialPatch.clearKeys),
  customHeaders: { ...pendingCredentialPatch.customHeaders },
})

/** 不能对动态键用 delete（会退化对象布局）：重建一个不含该键的新对象 */
const omitCredentialField = <K extends string, V>(
  record: Partial<Record<K, V>>,
  key: K
): Partial<Record<K, V>> => {
  const next: Partial<Record<K, V>> = {}
  for (const [entryKey, value] of Object.entries(record)) {
    if (entryKey !== key) {
      next[entryKey as K] = value as V
    }
  }
  return next
}

/** 把一次凭据变更意图并入账本：同槽位同字段后写覆盖先写，set 与 clear 互斥 */
const recordCredentialIntent = (intent: CredentialPatch) => {
  for (const [slot, value] of Object.entries(intent.keys)) {
    pendingCredentialPatch.keys[slot as SecretTarget] = value
    pendingCredentialPatch.clearKeys.delete(slot as SecretTarget)
  }
  for (const slot of intent.clearKeys) {
    pendingCredentialPatch.keys = omitCredentialField(pendingCredentialPatch.keys, slot)
    pendingCredentialPatch.clearKeys.add(slot)
  }
  for (const [slot, pairs] of Object.entries(intent.customHeaders)) {
    pendingCredentialPatch.customHeaders[slot as ChannelSlot] = pairs
  }
}

/**
 * 服务端已应用某批意图后，只清掉账本里仍保持该批取值的字段。
 * 请求飞行期间用户又录入的新意图必须保留，等待下一轮有界追平。
 */
const forgetAppliedCredentialPatch = (applied: CredentialPatch) => {
  for (const [slot, value] of Object.entries(applied.keys)) {
    const target = slot as SecretTarget
    if (pendingCredentialPatch.keys[target] === value) {
      pendingCredentialPatch.keys = omitCredentialField(pendingCredentialPatch.keys, target)
    }
  }
  for (const slot of applied.clearKeys) {
    if (
      pendingCredentialPatch.clearKeys.has(slot) &&
      pendingCredentialPatch.keys[slot] === undefined
    ) {
      pendingCredentialPatch.clearKeys.delete(slot)
    }
  }
  for (const [slot, pairs] of Object.entries(applied.customHeaders)) {
    const target = slot as ChannelSlot
    const current = pendingCredentialPatch.customHeaders[target]
    if (current && JSON.stringify(current) === JSON.stringify(pairs)) {
      pendingCredentialPatch.customHeaders = omitCredentialField(
        pendingCredentialPatch.customHeaders,
        target
      )
    }
  }
}

/** 把账本序列化为 /api/config 的凭据字段；空账本不附带任何凭据键 */
const credentialPayloadOf = (patch: CredentialPatch): Record<string, unknown> => {
  const payload: Record<string, unknown> = {}
  if (Object.keys(patch.keys).length > 0) {
    payload.keys = { ...patch.keys }
  }
  if (patch.clearKeys.size > 0) {
    payload.clearKeys = [...patch.clearKeys]
  }
  if (Object.keys(patch.customHeaders).length > 0) {
    payload.customHeaders = { ...patch.customHeaders }
  }
  return payload
}

/** 把一次服务端配置写操作排进串行链；链上失败的 Promise 不阻塞后续请求 */
const queueConfigRequest = <T,>(action: () => Promise<T>): Promise<T> => {
  const task = persistChain.then(action)
  persistChain = task.then(
    () => undefined,
    () => undefined
  )
  return task
}

/**
 * 凭据写请求：先把意图记账本再入串行链，请求体同时携带账本里所有尚未落盘的意图
 * （包括之前因文件锁 500 失败的那批），一次成功就能把积压意图全部追平。
 *
 * 失败时账本原样保留：ensureConfigSynced 据此发起有界合并重试，或在服务端仍不可写时
 * 立即抛错中止本次上传 / 聊天。apply 只在响应真正成功时调用，且带 staleSecrets 标记：
 * 若请求飞行期间又录入了更新的密钥意图，旧响应的掩码与指纹绝不能覆盖新状态。
 */
const queueCredentialRequest = (
  intent: CredentialPatch,
  apply: (snapshot: ConfigSnapshot, staleSecrets: boolean) => void
): Promise<void> => {
  recordCredentialIntent(intent)
  secretRevision += 1
  const revision = secretRevision
  const appliedPatch = snapshotCredentialPatch()
  const payload = credentialPayloadOf(appliedPatch)
  const task = queueConfigRequest(async () => {
    const response = await serverFetch('/api/config', {
      method: 'POST',
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(CONFIG_TIMEOUT_MS),
    })
    return readJson<ConfigSnapshot>(response)
  }).then((snapshot) => {
    apply(snapshot, secretRevision !== revision)
    forgetAppliedCredentialPatch(appliedPatch)
    if (revision > secretAppliedRevision) {
      secretAppliedRevision = revision
    }
    if (!hasPendingCredentialPatch() && lastSavedRevision >= editRevision) {
      useConfigStore.setState({ saving: false, saveError: false, saveFailure: 'none' })
    }
  })
  secretChain = task.then(
    () => undefined,
    () => {
      // 失败只记录状态，不在此打断串行链：账本保留，由 ensureConfigSynced 有界重试
      useConfigStore.setState({ saving: false, saveError: true, saveFailure: 'server' })
    }
  )
  return task
}

/**
 * 纯静态模式落盘：主备双槽位同写，任一写入失败即回滚两槽并抛出。
 *
 * localStorage 配额写满或隐私模式禁用存储时 setItem 会抛 QuotaExceededError /
 * SecurityError；这里绝不静默吞掉，否则界面会虚假显示 Saved 而配置实际没落地。
 */
const writeStaticSettings = (settings: AppSettings) => {
  const serialized = JSON.stringify(settings)
  const previousPrimary = localStorage.getItem(SETTINGS_KEY)
  const previousBackup = localStorage.getItem(SETTINGS_BACKUP_KEY)
  try {
    localStorage.setItem(SETTINGS_KEY, serialized)
    localStorage.setItem(SETTINGS_BACKUP_KEY, serialized)
  } catch (error) {
    // 主槽可能已经写入一半：恢复写入前的原始字节，内存状态由调用方保持不变
    for (const [key, previous] of [
      [SETTINGS_KEY, previousPrimary],
      [SETTINGS_BACKUP_KEY, previousBackup],
    ] as const) {
      try {
        if (previous === null) {
          localStorage.removeItem(key)
        } else {
          localStorage.setItem(key, previous)
        }
      } catch {
        // 回滚本身也可能受配额限制，尽力而为
      }
    }
    throw error instanceof Error ? error : new Error('localStorage write failed')
  }
}

/** 纯静态模式保存失败：状态位 + 轻提示双通道上报，绝不显示成功 */
const reportStaticSaveFailure = () => {
  useConfigStore.setState({ saveError: true, saveFailure: 'local' })
  showToast({ key: 'saveFailedLocalStorage', type: 'error' })
}

/**
 * 保存失败时该弹哪条提示。
 *
 * 只有“本地浏览器存储写失败”才提示清理浏览器空间：纯静态模式（file://）没有本地服务
 * 可查，或最近一次失败明确来自 localStorage。服务端模式下的 /api/config 500
 * configPersistFailed、网络失败都指向本地服务或 .console_data/ 目录权限，
 * 必须返回 saveFailed，绝不能被残留的 saveError 误导向 localStorage 文案。
 */
export const configSaveFailureKey = (): 'saveFailed' | 'saveFailedLocalStorage' => {
  const state = useConfigStore.getState()
  if (state.saveFailure === 'local') {
    return 'saveFailedLocalStorage'
  }
  if (state.saveFailure === 'server') {
    return 'saveFailed'
  }
  return state.mode === 'static' ? 'saveFailedLocalStorage' : 'saveFailed'
}

const persistServerSettings = async (revision: number, settings: AppSettings): Promise<void> => {
  if (useConfigStore.getState().mode !== 'server') {
    return
  }
  useConfigStore.setState({ saving: true })
  let snapshot: ConfigSnapshot
  try {
    const response = await serverFetch('/api/config', {
      method: 'POST',
      body: JSON.stringify({ settings }),
      signal: AbortSignal.timeout(CONFIG_TIMEOUT_MS),
    })
    snapshot = await readJson<ConfigSnapshot>(response)
  } catch {
    useConfigStore.setState({ saving: false, saveError: true, saveFailure: 'server' })
    throw new Error('config save failed')
  }
  lastSavedRevision = Math.max(lastSavedRevision, revision)
  const stale = editRevision !== revision
  useConfigStore.setState((state) => ({
    // 本地已有更新的编辑时，旧响应不得覆盖 settings
    settings: stale ? state.settings : sanitizeSettings(snapshot.settings),
    secrets: sanitizeSecretMasks(snapshot.secrets),
    storage: sanitizeStorageStatus(snapshot.storage),
    saving: stale,
    saveError: false,
    saveFailure: 'none',
  }))
}

const queuePersist = (): Promise<void> => {
  const revision = editRevision
  const settings = useConfigStore.getState().settings
  return queueConfigRequest(() => persistServerSettings(revision, settings))
}

/** 服务端模式的防抖落盘；纯静态模式在 updateSettings 内同步写并上报失败，不走这里 */
const schedulePersist = () => {
  if (saveTimer !== undefined) {
    clearTimeout(saveTimer)
  }
  saveTimer = setTimeout(() => {
    saveTimer = undefined
    void queuePersist().catch(() => {
      // 保存失败状态由 saveError 暴露给界面
    })
  }, SAVE_DEBOUNCE_MS)
}

/**
 * 发送聊天 / 上传远端文件前调用：取消防抖并按需做**有界**合并刷盘。
 *
 * 等待屏障包含两类写请求：settings 防抖保存（lastSavedRevision），以及 setSecret /
 * clearSecret / setCustomHeaders 的凭据写请求（secretAppliedRevision + 未落盘的
 * pendingCredentialPatch）。只改密钥、不改地址时 editRevision 不变，若不同时等凭据版本，
 * 上传会按旧 keyFingerprint 记录归属。
 *
 * 关键约束：
 * - 绝不用“无进展判定”的 while 循环：一次调用最多发出 2 次配置 POST；
 * - 第 1 次把积压的凭据账本与待保存 settings 合并成同一个请求；仅在请求飞行期间
 *   又出现了更新的编辑版本时才允许追平第 2 次；
 * - 服务端仍返回 500 / 网络失败（版本号无法推进）时立即抛错，让调用方中止本次
 *   上传或聊天，绝不在旧凭据上继续，也绝不无限重试。
 */
export const ensureConfigSynced = async (): Promise<void> => {
  if (useConfigStore.getState().mode !== 'server') {
    return
  }
  if (saveTimer !== undefined) {
    clearTimeout(saveTimer)
    saveTimer = undefined
  }
  // 先等所有已入队的配置写请求返回：成功的凭据写已推进版本号并更新掩码与指纹
  await secretChain
  await persistChain
  let attempts = 0
  for (;;) {
    const settingsDirty = lastSavedRevision < editRevision
    const credentialsDirty = secretAppliedRevision < secretRevision || hasPendingCredentialPatch()
    if (!settingsDirty && !credentialsDirty) {
      if (useConfigStore.getState().saveError) {
        useConfigStore.setState({ saveError: false, saveFailure: 'none' })
      }
      return
    }
    if (attempts >= 2) {
      // 两次合并刷盘后仍有更新的编辑版本未追平：中止调用方，绝不再发第三次
      throw new Error('config save failed')
    }
    attempts += 1
    const settingsRevision = editRevision
    const credentialRevision = secretRevision
    const appliedPatch = snapshotCredentialPatch()
    const payload: Record<string, unknown> = credentialPayloadOf(appliedPatch)
    if (settingsDirty) {
      payload.settings = useConfigStore.getState().settings
    }
    useConfigStore.setState({ saving: true })
    let snapshot: ConfigSnapshot
    try {
      snapshot = await queueConfigRequest(async () => {
        const response = await serverFetch('/api/config', {
          method: 'POST',
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(CONFIG_TIMEOUT_MS),
        })
        return readJson<ConfigSnapshot>(response)
      })
    } catch (error) {
      useConfigStore.setState({ saving: false, saveError: true, saveFailure: 'server' })
      throw error instanceof Error ? error : new Error('config save failed')
    }
    const staleSettings = editRevision !== settingsRevision
    const staleSecrets = secretRevision !== credentialRevision
    useConfigStore.setState((state) => ({
      // 本地已有更新编辑时，服务端旧快照绝不能覆盖内存里的新设置 / 新掩码
      settings: staleSettings ? state.settings : sanitizeSettings(snapshot.settings),
      secrets: staleSecrets ? state.secrets : sanitizeSecretMasks(snapshot.secrets),
      storage: sanitizeStorageStatus(snapshot.storage),
      saving: staleSettings || staleSecrets,
      saveError: false,
      saveFailure: 'none',
    }))
    lastSavedRevision = Math.max(lastSavedRevision, settingsRevision)
    secretAppliedRevision = Math.max(secretAppliedRevision, credentialRevision)
    forgetAppliedCredentialPatch(appliedPatch)
  }
}

// ---------------------------------------------------------------------------
// 初始化与模式判定
// ---------------------------------------------------------------------------

const probeHealth = async (token: string): Promise<boolean> => {
  try {
    const response = await fetch('/api/health', {
      headers: token ? { 'X-Console-Token': token } : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    })
    if (!response.ok) {
      return false
    }
    const payload = (await response.json()) as HealthPayload
    return payload.ok === true && payload.service === 'engineering-ai-console'
  } catch {
    return false
  }
}

const loadServerSnapshot = async (): Promise<boolean> => {
  try {
    const response = await serverFetch('/api/config', {
      signal: AbortSignal.timeout(CONFIG_TIMEOUT_MS),
    })
    const snapshot = await readJson<ConfigSnapshot>(response)
    editRevision = 0
    lastSavedRevision = 0
    secretRevision = 0
    secretAppliedRevision = 0
    pendingCredentialPatch = emptyCredentialPatch()
    useConfigStore.setState({
      ready: true,
      offline: false,
      initError: null,
      settings: sanitizeSettings(snapshot.settings),
      secrets: sanitizeSecretMasks(snapshot.secrets),
      storage: sanitizeStorageStatus(snapshot.storage),
      saving: false,
      saveError: false,
      saveFailure: 'none',
    })
    return true
  } catch {
    // http(s) 下不降级 static：保持 server 模式并提示本地服务不可达
    useConfigStore.setState({ ready: true, offline: true, initError: 'serverOffline', saving: false })
    return false
  }
}

const parseStaticSettings = (raw: string | null): AppSettings | null => {
  if (!raw) {
    return null
  }
  try {
    return sanitizeSettings(JSON.parse(raw))
  } catch {
    return null
  }
}

/** 主槽优先；主槽损坏时回退备槽，并把修复后的配置写回主槽 */
const loadStaticSettings = (): { settings: AppSettings; recovered: boolean } => {
  const primary = parseStaticSettings(readStorage(SETTINGS_KEY))
  if (primary) {
    return { settings: primary, recovered: false }
  }
  const backup = parseStaticSettings(readStorage(SETTINGS_BACKUP_KEY))
  if (backup) {
    writeStorage(SETTINGS_KEY, JSON.stringify(backup))
    return { settings: backup, recovered: true }
  }
  return { settings: createDefaultSettings(), recovered: false }
}

const enterStaticMode = () => {
  const { settings, recovered } = loadStaticSettings()
  editRevision = 0
  lastSavedRevision = 0
  secretRevision = 0
  secretAppliedRevision = 0
  pendingCredentialPatch = emptyCredentialPatch()
  useConfigStore.setState({
    mode: 'static',
    ready: true,
    offline: false,
    initError: null,
    serverToken: '',
    settings,
    secrets: masksOf(settings),
    storage: recovered
      ? { settings: 'recovered', secrets: 'missing', recovered: true, degraded: false }
      : EMPTY_STORAGE_STATUS(),
  })
}

export const initConfig = async (): Promise<void> => {
  // 只有 file:// 才是纯静态直连；http(s) 一律视为服务端模式
  if (location.protocol === 'file:') {
    enterStaticMode()
    return
  }
  const token = readServerToken()
  useConfigStore.setState({ mode: 'server', serverToken: token })
  if (!(await probeHealth(token))) {
    useConfigStore.setState({ ready: true, offline: true, initError: 'serverOffline' })
    return
  }
  await loadServerSnapshot()
}

/** 离线横幅的重试入口：重新探测 /api/health 后再拉取 /api/config */
export async function retryInit(): Promise<void> {
  if (location.protocol === 'file:') {
    enterStaticMode()
    return
  }
  const token = readServerToken()
  useConfigStore.setState({
    mode: 'server',
    serverToken: token,
    ready: false,
    offline: false,
    initError: null,
  })
  if (!(await probeHealth(token))) {
    useConfigStore.setState({ ready: true, offline: true, initError: 'serverOffline' })
    return
  }
  await loadServerSnapshot()
}

// ---------------------------------------------------------------------------
// 编辑入口
// ---------------------------------------------------------------------------

/**
 * 统一编辑入口：返回是否真正落盘成功。
 *
 * 纯静态模式先同步写 localStorage 再更新内存：写入失败时内存保持原值（等价于回滚），
 * 返回 false 并弹出失败提示；服务端模式仍走防抖队列，成功入队即返回 true。
 */
const updateSettings = (updater: (settings: AppSettings) => AppSettings): boolean => {
  const state = useConfigStore.getState()
  const next = updater(state.settings)
  if (state.mode === 'static') {
    try {
      writeStaticSettings(next)
    } catch {
      reportStaticSaveFailure()
      return false
    }
    useConfigStore.setState({
      settings: next,
      secrets: masksOf(next),
      saveError: false,
      saveFailure: 'none',
    })
    return true
  }
  editRevision += 1
  useConfigStore.setState({ settings: next })
  schedulePersist()
  return true
}

export const setUiSettings = (patch: Partial<UiSettings>): boolean =>
  updateSettings((settings) => ({ ...settings, ui: { ...settings.ui, ...patch } }))

export const setLocale = (locale: Locale): boolean => setUiSettings({ locale })

export const setActiveChannel = (slot: ChannelSlot): boolean =>
  updateSettings((settings) => ({ ...settings, activeChannel: slot }))

export const setThinking = (thinking: boolean): boolean =>
  updateSettings((settings) => ({ ...settings, thinking }))

export const setWebSearch = (webSearch: boolean): boolean =>
  updateSettings((settings) => ({ ...settings, webSearch }))

export const patchChannel = (
  slot: ChannelSlot,
  patch: Partial<ChannelConfig>
): boolean =>
  updateSettings((settings) => ({
    ...settings,
    channels: { ...settings.channels, [slot]: { ...settings.channels[slot], ...patch } },
  }))

export const setExaConfig = (patch: Partial<ExaConfig>): boolean =>
  updateSettings((settings) => ({ ...settings, exa: { ...settings.exa, ...patch } }))

export const patchPrompts = (patch: Partial<PromptSettings>): boolean =>
  updateSettings((settings) => ({ ...settings, prompts: { ...settings.prompts, ...patch } }))

/** 保存某项自定义提示词；空串表示删除自定义并回退默认 */
export const setSystemPrompt = (locale: Locale, prompt: string): boolean =>
  updateSettings((settings) => {
    const systemPrompt = { ...settings.prompts.systemPrompt }
    systemPrompt[locale] = prompt.trim() ? prompt : undefined
    return { ...settings, prompts: { ...settings.prompts, systemPrompt } }
  })

export const setCapsuleTemplate = (
  locale: Locale,
  id: CapsuleId,
  template: string
): boolean =>
  updateSettings((settings) => {
    const capsules = { ...settings.prompts.capsules }
    const entry = { ...(capsules[locale] ?? {}) }
    entry[id] = template.trim() ? template : undefined
    capsules[locale] = Object.values(entry).some((value) => typeof value === 'string' && value.trim())
      ? entry
      : undefined
    return { ...settings, prompts: { ...settings.prompts, capsules } }
  })

export const setWatchdogSettings = (patch: Partial<WatchdogSettings>): boolean =>
  updateSettings((settings) => ({ ...settings, watchdog: { ...settings.watchdog, ...patch } }))

// ---------------------------------------------------------------------------
// 密钥与自定义 Header
// ---------------------------------------------------------------------------

/**
 * 设置弹窗里“已经输入但还没点旁边保存按钮”的凭据草稿提交点。
 *
 * 用户在密钥框里粘贴了 KEY、直接点“连通性自检”或关闭弹窗时，草稿必须自动落盘：
 * 过去自检会把草稿密钥带进探测请求（所以能通过），而对话只读已保存密钥（于是 401），
 * 正是“连通性测试通过却无法对话”的根因。
 */
type CredentialDraftCommitter = () => Promise<void>

const credentialDraftCommitters = new Set<CredentialDraftCommitter>()

export const registerCredentialDraftCommitter = (
  committer: CredentialDraftCommitter
): (() => void) => {
  credentialDraftCommitters.add(committer)
  return () => {
    credentialDraftCommitters.delete(committer)
  }
}

/** 逐个提交已注册的凭据草稿；任一失败向上抛，由调用方决定提示文案与是否继续。 */
export const commitPendingCredentials = async (): Promise<void> => {
  for (const committer of [...credentialDraftCommitters]) {
    await committer()
  }
}

const setSecretMask = (target: SecretTarget, mask: SecretMask) => {
  useConfigStore.setState((state) => ({ secrets: { ...state.secrets, [target]: mask } }))
}

const normalizeHeaderPairs = (pairs: HeaderPair[]): HeaderPair[] =>
  pairs.map((pair) => ({ name: pair.name.trim(), value: pair.value.trim() }))

/** 自定义 Header：服务端模式只提交新值，值本身永远不进入 settings；静态模式直接编辑 */
export async function setCustomHeaders(slot: ChannelSlot, pairs: HeaderPair[]): Promise<void> {
  const normalized = normalizeHeaderPairs(pairs)
  const state = useConfigStore.getState()
  if (state.mode === 'static') {
    // 纯静态模式写本地存储失败时必须让调用方看到错误，绝不假装保存成功
    if (!patchChannel(slot, { customHeaders: normalized })) {
      throw new Error('config save failed')
    }
    return
  }
  await queueCredentialRequest(
    { keys: {}, clearKeys: new Set(), customHeaders: { [slot]: normalized } },
    (snapshot, staleSecrets) => {
      const hasPendingEdits = editRevision !== lastSavedRevision
      useConfigStore.setState((current) => ({
        // 仍有未保存的本地编辑时，不能让服务端旧快照覆盖内存
        settings: hasPendingEdits ? current.settings : sanitizeSettings(snapshot.settings),
        secrets: staleSecrets ? current.secrets : sanitizeSecretMasks(snapshot.secrets),
        storage: sanitizeStorageStatus(snapshot.storage),
      }))
    }
  )
}

/** 写入密钥：服务端模式只提交密钥字段；纯静态模式直接落在本地配置 */
export const setSecret = async (target: SecretTarget, secret: string): Promise<void> => {
  const value = secret.trim()
  if (!value) {
    await clearSecret(target)
    return
  }
  const state = useConfigStore.getState()
  if (state.mode === 'static') {
    const applied =
      target === 'exa' ? setExaConfig({ apiKey: value }) : patchChannel(target, { apiKey: value })
    if (!applied) {
      throw new Error('config save failed')
    }
    setSecretMask(target, maskSecretWithFingerprint(value))
    return
  }
  await queueCredentialRequest(
    { keys: { [target]: value }, clearKeys: new Set(), customHeaders: {} },
    (snapshot, staleSecrets) => {
      useConfigStore.setState((current) => ({
        secrets: staleSecrets ? current.secrets : sanitizeSecretMasks(snapshot.secrets),
        storage: sanitizeStorageStatus(snapshot.storage),
      }))
    }
  )
}

export const clearSecret = async (target: SecretTarget): Promise<void> => {
  const state = useConfigStore.getState()
  if (state.mode === 'static') {
    const applied =
      target === 'exa' ? setExaConfig({ apiKey: '' }) : patchChannel(target, { apiKey: '' })
    if (!applied) {
      throw new Error('config save failed')
    }
    setSecretMask(target, { hasKey: false, mask: '' })
    return
  }
  await queueCredentialRequest(
    { keys: {}, clearKeys: new Set([target]), customHeaders: {} },
    (snapshot, staleSecrets) => {
      useConfigStore.setState((current) => ({
        secrets: staleSecrets ? current.secrets : sanitizeSecretMasks(snapshot.secrets),
        storage: sanitizeStorageStatus(snapshot.storage),
      }))
    }
  )
}

/** 硬复位时可选保留本地已存密钥（仅纯静态模式有本地密钥） */
export const collectLocalSecrets = (): Record<SecretTarget, string> => {
  const settings = useConfigStore.getState().settings
  return {
    primary: settings.channels.primary.apiKey,
    backup: settings.channels.backup.apiKey,
    exa: settings.exa.apiKey,
  }
}

export const restoreLocalSecrets = (secrets: Record<SecretTarget, string>) => {
  if (useConfigStore.getState().mode !== 'static') {
    return
  }
  patchChannel('primary', { apiKey: secrets.primary })
  patchChannel('backup', { apiKey: secrets.backup })
  setExaConfig({ apiKey: secrets.exa })
  useConfigStore.setState({
    secrets: {
      primary: maskSecretWithFingerprint(secrets.primary),
      backup: maskSecretWithFingerprint(secrets.backup),
      exa: maskSecretWithFingerprint(secrets.exa),
      customHeaders: { primary: [], backup: [] },
    },
  })
}

/**
 * 硬复位的数据侧：本地配置全部回到默认值（含双槽位），不写回服务端 .console_data。
 * 密钥是否保留由调用方在重置后再单独填回，避免旧 URL / 字号 / 提示词被带回来。
 * 尚未落盘的凭据意图账本随复位整体清空：复位后旧密钥不应在下次上传时被偷偷追平。
 */
export const resetConfigToDefaults = () => {
  if (saveTimer !== undefined) {
    clearTimeout(saveTimer)
    saveTimer = undefined
  }
  editRevision += 1
  lastSavedRevision = editRevision
  secretRevision = 0
  secretAppliedRevision = 0
  pendingCredentialPatch = emptyCredentialPatch()
  useConfigStore.setState({
    settings: createDefaultSettings(),
    secrets: EMPTY_SECRET_MASKS(),
    storage: EMPTY_STORAGE_STATUS(),
    saving: false,
    saveError: false,
    saveFailure: 'none',
  })
  removeStorage(SETTINGS_KEY)
  removeStorage(SETTINGS_BACKUP_KEY)
}

export const clearLocalSettings = () => {
  removeStorage(SETTINGS_KEY)
  removeStorage(SETTINGS_BACKUP_KEY)
}

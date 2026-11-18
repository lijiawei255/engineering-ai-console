/**
 * 会话状态与发送编排。
 *
 * 责任边界：
 * - 中立消息树（用户 / 助手），发送时按当前活动通道协议动态序列化；
 * - 动作胶囊只在本轮请求末尾注入，绝不改 system 字段；
 * - 流式更新按 80 ms 合并写回，长流期间每 3 秒落盘一次；
 * - 看门狗中断保留半截内容并提供重试；
 * - 图片-only 被拒时回滚消息并完整恢复草稿。
 */

import { create } from 'zustand'
import { showToast } from '../../components/base/toastState.js'
import {
  resolveCapsuleInstruction,
  resolveSystemPrompt,
} from '../../prompts/defaults.js'
import {
  collectImageInputs,
  collectRemoteFiles,
  buildAttachmentPrompt,
  formatSize,
  isRejectedAttachment,
  type Attachment,
} from '../attachments/index.js'
import { StreamError, type HistoryMessage, type UsageInfo } from '../api/types.js'
import { pickModel } from '../api/serialize.js'
import { streamChat, mergeUsage } from '../api/stream.js'
import { normalizeChatUrl } from '../api/url.js'
import {
  ensureConfigSynced,
  getActiveChannel,
  getServerToken,
  getSettings,
  remoteKeyFingerprintOf,
  setActiveChannel,
  useConfigStore,
} from '../config/store.js'
import { remoteFileFingerprint } from '../api/files.js'
import type { CapsuleId, ChannelSlot } from '../config/types.js'
import { formatExaContext, searchExa } from '../search/exa.js'
import { createId } from '../../utils/id.js'
import { ownValue, withOwnValue, withoutKey } from '../../utils/records.js'
import { translate, type TranslationKey } from '../../i18n/index.js'
import {
  clearAllSessions,
  deleteSessionRecord,
  listSessionSummaries,
  loadAllSessions,
  loadSession,
  saveSession,
} from './db.js'
import {
  addDraftAttachment,
  clearAllDrafts,
  clearDraft,
  getDraft,
  getDraftRevision,
  loadDrafts,
  restoreDraft,
} from './drafts.js'
import {
  deriveTitle,
  isAssistantMessage,
  isUserMessage,
  normalizeLoadedSession,
  type AssistantMessage,
  type ChatMessage,
  type MessageError,
  type ReplyStatus,
  type Session,
  type SessionSummary,
  type UserMessage,
  toSessionSummary,
} from './types.js'

export interface ChatState {
  ready: boolean
  /**
   * 启动读取失败原因：`'read'` 表示浏览器本地会话存储（IndexedDB 摘要列表）读取失败。
   * 与保存失败（`saveError`）严格区分：界面据此展示准确的读取失败文案，绝不误报“保存失败”。
   */
  initFailure: 'read' | null
  summaries: SessionSummary[]
  sessionCache: Record<string, Session>
  activeId: string | null
  streaming: Record<string, boolean>
  pendingCapsule: CapsuleId | null
  resetEpoch: number
  saveError: boolean
}

export const useChatStore = create<ChatState>(() => ({
  ready: false,
  initFailure: null,
  summaries: [],
  sessionCache: {},
  activeId: null,
  streaming: {},
  pendingCapsule: null,
  resetEpoch: 0,
  saveError: false,
}))

const FLUSH_INTERVAL_MS = 80
const PERSIST_INTERVAL_MS = 3000

/**
 * 会话更新时间必须单调递增：同一毫秒内连续到达的两次状态更新也要产生严格更新的时间戳。
 * 否则数据库记录、应急快照与内存缓存会在“同毫秒平局”时无法判定谁是最新完整状态，
 * 刷新后可能用旧记录覆盖刚刚生成完的完整回复。
 */
const nextUpdatedAt = (previous: number): number => Math.max(previous + 1, Date.now())

interface SessionAttempt {
  assistantId: string
  /** 每轮流式请求的唯一代次：软复位后同消息重试会产生新代次，旧代次不得再回写状态 */
  attemptId: string
  controller: AbortController
  text: string
  reasoning: string
  reasoningStart: number | null
  reasoningEnd: number | null
  flushTimer: ReturnType<typeof setTimeout> | null
  lastPersist: number
  usage?: UsageInfo
  notice?: 'modality-downgraded'
}

type StreamingEntry = SessionAttempt

const entries = new Map<string, StreamingEntry>()

/**
 * 已删除会话墓碑：deleteSession 在 IndexedDB 事务成功之后落墓碑。
 * 任何早于删除启动、但在删除之后才到达的异步回调（流式取消、落盘、草稿恢复）
 * 都必须静默丢弃，否则 IndexedDB 里已删掉的会话会被旧回调重新写回。
 */
const deletedSessions = new Set<string>()

/**
 * 单会话独立版本号：只有该会话 id 被删除、被导入覆盖或被全量复位时递增。
 *
 * 旧实现用一个全局 cacheEpoch 表示“任何一次缓存变更”，导致删除无关会话 B 会让正在
 * 加载的 A 被误判为过期而卡在 Loading…；导入备份也会把后台正在流式生成且带未发图片
 * 草稿的无关会话 A 一并作废。这里改为按 id 记账，全局复位才用 resetEpoch。
 */
const sessionRevs: Record<string, number> = Object.create(null)

export const getSessionRev = (sessionId: string): number => sessionRevs[sessionId] ?? 0

const bumpSessionRev = (sessionId: string): number => {
  const next = getSessionRev(sessionId) + 1
  sessionRevs[sessionId] = next
  return next
}

/**
 * 欢迎页（sessionId === null）草稿的独立版本号：全量清空 / 复位 / 欢迎页草稿迁入
 * 新会话时递增，用来丢弃迟到的异步附件解析结果。
 */
let welcomeDraftRev = 0

export const getWelcomeDraftRev = (): number => welcomeDraftRev

/**
 * 会话切换请求序号：单调递增，用来判断一次异步读取是否仍代表“用户最后一次选择”。
 *
 * selectSession 开始时捕获自己的序号；读取返回时若期间又发生过选择、切回欢迎页、
 * 导入接管或复位，旧回调一律不得再更新 activeId，也不得清空加载态。否则会出现
 * “读取旧 A → 删除 A → 导入同 ID 的 A' 并立即选中 → 旧读取回调把 A' 的 activeId
 * 误清为 null、正文已加载却退回欢迎页”的竞态。
 *
 * 序号只在选择态真正变化时递增：删除无关会话不会递增，避免让正在加载的另一个
 * 会话被误判为过期而永久卡在 Loading…（与 sessionRevs 的设计保持一致）。
 */
let selectSeq = 0

const beginSelection = (): number => {
  selectSeq += 1
  return selectSeq
}

/**
 * 在途 IndexedDB 写盘；删除 / 复位前先排空，避免事务乱序把已删记录写回来。
 * deletingSessions / bulkDeleteBarrier 是删除事务期间的临时写盘屏障：旧流即使还没
 * 收到 abort，也不允许再往库里写目标会话。
 */
const pendingSaves = new Set<Promise<unknown>>()
const deletingSessions = new Set<string>()
let bulkDeleteBarrier = false

const currentEpoch = (): number => useChatStore.getState().resetEpoch

const trackSave = <T,>(promise: Promise<T>): Promise<T> => {
  pendingSaves.add(promise)
  void promise.then(
    () => pendingSaves.delete(promise),
    () => pendingSaves.delete(promise)
  )
  return promise
}

/** 等待所有在途会话写盘落地；删除单条 / 清库前调用，避免旧事务在 clear 之后提交。 */
export const waitForPendingSaves = async (): Promise<void> => {
  while (pendingSaves.size > 0) {
    await Promise.allSettled(Array.from(pendingSaves))
  }
}

const getSession = (sessionId: string): Session | undefined =>
  ownValue(useChatStore.getState().sessionCache, sessionId)

/** 供界面与自检使用：动态 ID 查表必须先确认是自有属性，避免原型链键误判 */
export const getCachedSession = (sessionId: string): Session | undefined =>
  getSession(sessionId)

const patchMessage = (
  sessionId: string,
  messageId: string,
  patch: Partial<AssistantMessage> | Partial<UserMessage>,
  touch = true
) => {
  if (deletedSessions.has(sessionId)) {
    return
  }
  useChatStore.setState((state) => {
    const session = ownValue(state.sessionCache, sessionId)
    if (!session) {
      return state
    }
    const messages = session.messages.map((message) =>
      message.id === messageId ? ({ ...message, ...patch } as ChatMessage) : message
    )
    const next: Session = {
      ...session,
      messages,
      updatedAt: touch ? nextUpdatedAt(session.updatedAt) : session.updatedAt,
    }
    const summaries = state.summaries
      .map((summary) => (summary.id === sessionId ? toSessionSummary(next) : summary))
      .sort((left, right) => right.updatedAt - left.updatedAt)
    return { sessionCache: withOwnValue(state.sessionCache, sessionId, next), summaries }
  })
}

const setSession = (session: Session) => {
  useChatStore.setState((state) => {
    const summaries = state.summaries
      .map((summary) => (summary.id === session.id ? toSessionSummary(session) : summary))
      .sort((left, right) => right.updatedAt - left.updatedAt)
    return { sessionCache: withOwnValue(state.sessionCache, session.id, session), summaries }
  })
}

let saveErrorNotified = false

/**
 * 落盘失败的应急快照键：IndexedDB 事务连续失败（磁盘满、数据库被拒绝写入）时，
 * 把该会话最新完整消息树同步写进 localStorage。刷新 / 重选会话时优先用时间戳更新的
 * 应急快照恢复并补写回 IndexedDB，保证界面上已经显示的完整回复不会蒸发成 pending 空消息。
 */
const UNSAVED_SESSION_PREFIX = 'eac:unsaved:session:'

interface UnsavedSessionSnapshot {
  savedAt: number
  session: Session
}

const unsavedSessionKey = (sessionId: string): string => `${UNSAVED_SESSION_PREFIX}${sessionId}`

/** 写应急快照；localStorage 也可能已满 / 被禁用，失败只放弃快照，绝不影响保存失败上报 */
const writeUnsavedSnapshot = (session: Session) => {
  try {
    const savedAt = Date.now()
    const snapshot: UnsavedSessionSnapshot = {
      savedAt,
      // 快照必须带上严格更新的时间戳：同毫秒内最后一次落盘失败时，
      // 数据库里可能正好留着同一毫秒的旧记录，恢复路径不能把完整正文判成过期。
      session: { ...session, updatedAt: Math.max(session.updatedAt, savedAt) },
    }
    localStorage.setItem(unsavedSessionKey(session.id), JSON.stringify(snapshot))
  } catch {
    // 应急通道不可用时保持静默：saveError 已经暴露真实落盘失败
  }
}

const readUnsavedSnapshot = (sessionId: string): UnsavedSessionSnapshot | null => {
  try {
    const raw = localStorage.getItem(unsavedSessionKey(sessionId))
    if (!raw) {
      return null
    }
    const parsed = JSON.parse(raw) as Partial<UnsavedSessionSnapshot> | null
    if (!parsed || typeof parsed !== 'object' || !parsed.session) {
      return null
    }
    const session = normalizeLoadedSession(parsed.session as Session)
    return {
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0,
      session,
    }
  } catch {
    return null
  }
}

const removeUnsavedSnapshot = (sessionId: string) => {
  try {
    localStorage.removeItem(unsavedSessionKey(sessionId))
  } catch {
    // 忽略：存储不可用时本来也没有快照可清
  }
}

/** 列出所有残留应急快照的会话 ID（按存储中的键顺序，遍历过程本身受 try/catch 保护） */
const unsavedSessionIds = (): string[] => {
  const ids: string[] = []
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index)
      if (key && key.startsWith(UNSAVED_SESSION_PREFIX)) {
        ids.push(key.slice(UNSAVED_SESSION_PREFIX.length))
      }
    }
  } catch {
    // 存储不可用：没有可恢复的快照
  }
  return ids
}

const clearAllUnsavedSnapshots = () => {
  for (const sessionId of unsavedSessionIds()) {
    removeUnsavedSnapshot(sessionId)
  }
}

/** 同一会话的完整度评分：消息条数优先，其次正文总长度；只用于同毫秒平局时的取舍 */
const sessionCompleteness = (session: Session): number => {
  let total = session.messages.length * 1_000_000
  for (const message of session.messages) {
    total += message.content.length
  }
  return total
}

/**
 * 多来源会话状态比较：时间戳更新者优先；同毫秒平局时消息更多、正文更长者视为更完整。
 * 数据库记录、应急快照与内存缓存可能分别停留在不同阶段，必须用同一套规则判定。
 */
const preferSession = (candidate: Session, current: Session | undefined): boolean => {
  if (!current) {
    return true
  }
  if (candidate.updatedAt !== current.updatedAt) {
    return candidate.updatedAt > current.updatedAt
  }
  return sessionCompleteness(candidate) >= sessionCompleteness(current)
}

/**
 * 严格备份读取失败：全库读取在自动重试一次后仍失败，或已知摘要中的未删除会话在合并
 * 结果里找不到完整记录。硬复位与用户主动导出必须据此中止——残缺的抢救包一旦放行，
 * 紧接着的清库会永久抹掉没被读到的会话正文。
 */
export class BackupReadIncompleteError extends Error {
  readonly code = 'backupIncomplete'

  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'BackupReadIncompleteError'
    if (cause !== undefined) {
      this.cause = cause
    }
  }
}

export interface BackupLoadOptions {
  /**
   * 严格完整性模式：数据库全库读取失败（单次瞬态事务中止会自动重试一次）或摘要覆盖
   * 复核发现缺失时直接抛错，绝不退化为“缓存 + 应急快照”的残缺导出。
   * 硬复位抢救包与用户主动导出必须启用；非严格模式只用于内部只读诊断。
   */
  requireCompleteDbRead?: boolean
}

/**
 * 备份与抢救包的统一读取入口：IndexedDB 记录、localStorage 中的应急快照、当前内存
 * sessionCache 按会话 ID 合并，每个会话取最新完整状态。
 *
 * 首次落盘就失败的会话可能只存在于应急快照或内存里，绝不能因为数据库没有记录就漏出导出；
 * 反过来，数据库可读时也不能让更旧的缓存覆盖刚写进去的完整回复。
 *
 * 完整性守卫（默认关闭的严格模式由硬复位 / 用户导出启用）：
 * 1. 全库读取首次失败时立即用全新的显式只读事务重试一次，抵消单次瞬态事务中止；
 * 2. 重试后仍失败时，严格模式直接向上抛错，不允许静默吞掉异常只拿不完整的
 *    sessionCache + 应急快照拼凑结果；
 * 3. 合并完成后复核摘要覆盖：任何未删除会话 ID 若没有完整会话记录同样视为不完整。
 */
export const loadSessionsForBackup = async (
  options: BackupLoadOptions = {}
): Promise<Session[]> => {
  const requireComplete = options.requireCompleteDbRead === true
  const byId = new Map<string, Session>()
  try {
    for (const session of await loadAllSessions()) {
      byId.set(session.id, session)
    }
  } catch {
    // 单次瞬态事务中止：换一个全新的显式只读事务重试一次（与 saveSession 容错对称）
    try {
      for (const session of await loadAllSessions()) {
        byId.set(session.id, session)
      }
    } catch (error) {
      if (requireComplete) {
        throw new BackupReadIncompleteError('complete session database read failed', error)
      }
      // 非严格模式：数据库暂不可读时仍用应急快照与内存缓存导出
    }
  }
  const cache = useChatStore.getState().sessionCache
  for (const [sessionId, session] of Object.entries(cache)) {
    if (preferSession(session, byId.get(sessionId))) {
      byId.set(sessionId, session)
    }
  }
  for (const sessionId of unsavedSessionIds()) {
    const snapshot = readUnsavedSnapshot(sessionId)
    if (snapshot && preferSession(snapshot.session, byId.get(sessionId))) {
      byId.set(sessionId, snapshot.session)
    }
  }
  if (requireComplete) {
    // 摘要与完整记录在同一个事务里写入：摘要里存在的未删除会话必须能在合并结果中找到
    // 完整记录，否则说明本次读取不完整（或数据库已损坏），严格模式下宁可拒绝导出。
    const missing = useChatStore
      .getState()
      .summaries.filter((summary) => !deletedSessions.has(summary.id) && !byId.has(summary.id))
    if (missing.length > 0) {
      throw new BackupReadIncompleteError('summary coverage incomplete')
    }
  }
  return [...byId.values()].sort(
    (left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id)
  )
}

/**
 * 硬复位阶段四：清库事务成功提交之后才允许抹掉的不可恢复本地状态。
 *
 * 单独抽出来是为了让调用方严格把“清应急快照 / 草稿 / 内存会话”排在 clearDatabase()
 * resolve 之后；清库被 abort 时绝不能走到这里，否则刷新后就再也恢复不了完整回复。
 */
export const clearLocalStateAfterDatabasePurge = () => {
  clearAllUnsavedSnapshots()
  clearAllDrafts()
  // 清库提交后 activeId 归零：同样递增选择序号，让任何在途读取立即失效
  beginSelection()
  useChatStore.setState({
    summaries: [],
    sessionCache: {},
    activeId: null,
    streaming: {},
    pendingCapsule: null,
    saveError: false,
  })
}

/** 成功落盘后清掉该会话的应急快照，并把失败状态复位 */
const clearPersistFailure = (sessionId: string) => {
  removeUnsavedSnapshot(sessionId)
  if (useChatStore.getState().saveError) {
    useChatStore.setState({ saveError: false })
    saveErrorNotified = false
  }
}

/** 写盘目标是否仍然有效（未被删除、未复位、未被批量删除屏障拦截） */
const isPersistTargetAlive = (sessionId: string, expectedEpoch: number): boolean =>
  !bulkDeleteBarrier &&
  !deletingSessions.has(sessionId) &&
  !deletedSessions.has(sessionId) &&
  currentEpoch() === expectedEpoch

/**
 * 会话落盘：单次事务失败（可能是一次瞬态 abort）时立即用最新快照重试一次；
 * 重试仍失败才写应急快照并报错。删除 / 复位中的会话绝不重试、也绝不写应急快照，
 * 否则已删除的会话会被下一次刷新复活。
 */
const persistSession = async (
  sessionId: string,
  expectedEpoch: number = currentEpoch(),
  options: { quiet?: boolean } = {}
): Promise<boolean> => {
  // 写盘入口先核验写盘屏障、代次与墓碑：删除事务进行中 / 已删除会话 / 已复位代次的
  // 任何旧回调都不允许落盘。
  if (!isPersistTargetAlive(sessionId, expectedEpoch)) {
    return false
  }
  const session = getSession(sessionId)
  if (!session) {
    return false
  }
  // 快照与真正发盘之间不再有 await：墓碑 / 代次若在等待中被改写，这里必须最后一次拦截
  if (!isPersistTargetAlive(sessionId, expectedEpoch)) {
    return false
  }
  const snapshot = session
  try {
    await trackSave(saveSession(snapshot))
    clearPersistFailure(sessionId)
    return true
  } catch {
    // 第一次失败先不报错：确认会话仍存活后立即开启新事务重试一次，消除单次瞬态中止
  }
  const latest = getSession(sessionId)
  if (!latest || !isPersistTargetAlive(sessionId, expectedEpoch)) {
    return false
  }
  try {
    await trackSave(saveSession(latest))
    clearPersistFailure(sessionId)
    return true
  } catch {
    // 连续两次失败：保留最新完整快照到应急键，界面与刷新后的恢复都以此为准
    writeUnsavedSnapshot(latest)
    if (!options.quiet && !saveErrorNotified) {
      saveErrorNotified = true
      try {
        // 轻提示依赖浏览器计时器；不可用时保存失败本身仍通过 saveError 暴露
        showToast({ key: 'saveFailed', type: 'error' })
      } catch {
        // 忽略提示失败
      }
    }
    useChatStore.setState({ saveError: true })
    return false
  }
}

const setStreaming = (sessionId: string, value: boolean) => {
  useChatStore.setState((state) => ({
    streaming: value
      ? withOwnValue(state.streaming, sessionId, true)
      : withoutKey(state.streaming, sessionId),
  }))
}

const reasoningSeconds = (entry: StreamingEntry): number | undefined => {
  if (entry.reasoningStart === null) {
    return undefined
  }
  const end = entry.reasoningEnd ?? Date.now()
  return Math.max(1, Math.round((end - entry.reasoningStart) / 1000))
}

const flushEntry = (sessionId: string) => {
  const entry = entries.get(sessionId)
  if (!entry) {
    return
  }
  entry.flushTimer = null
  patchMessage(sessionId, entry.assistantId, {
    content: entry.text,
    reasoning: entry.reasoning || undefined,
    reasoningMs: reasoningSeconds(entry),
    status: 'streaming' as ReplyStatus,
    usage: entry.usage,
    notice: entry.notice,
  })
  if (Date.now() - entry.lastPersist > PERSIST_INTERVAL_MS) {
    entry.lastPersist = Date.now()
    void persistSession(sessionId)
  }
}

const scheduleFlush = (sessionId: string) => {
  const entry = entries.get(sessionId)
  if (!entry || entry.flushTimer !== null) {
    return
  }
  entry.flushTimer = setTimeout(() => flushEntry(sessionId), FLUSH_INTERVAL_MS)
}

const configErrorKeyOf = (code: string): string => {
  switch (code) {
    case 'emptyUrl':
      return 'urlErrorEmpty'
    case 'invalidUrl':
      return 'urlErrorInvalid'
    case 'invalidProtocol':
      return 'urlErrorProtocol'
    case 'baseUrlHasQuery':
      return 'urlErrorQuery'
    case 'emptyModel':
      return 'emptyModelError'
    case 'payloadTooLarge':
      return 'errorPayloadTooLarge'
    case 'configSaveFailed':
      return 'saveFailed'
    default:
      return 'errorConfig'
  }
}

const configErrorTranslationKey = (code: string): TranslationKey =>
  configErrorKeyOf(code) as TranslationKey

const channelUsable = (slot: ChannelSlot): string | null => {
  const channel = getSettings().channels[slot]
  if (!channel.model.trim()) {
    return 'emptyModel'
  }
  const url = normalizeChatUrl(channel)
  return url.ok ? null : url.error
}

const ensureSession = (text: string, attachments: Attachment[]): string => {
  const state = useChatStore.getState()
  if (state.activeId) {
    return state.activeId
  }
  const now = Date.now()
  const titleSource = text.trim() || attachments[0]?.name || ''
  const session: Session = {
    id: createId(),
    title: deriveTitle(titleSource, translate('untitledChat')),
    createdAt: now,
    updatedAt: now,
    messages: [],
  }
  // 从欢迎页新建会话也是一次选择态变更：在途的旧 selectSession 不得再清空它
  beginSelection()
  useChatStore.setState((current) => ({
    activeId: session.id,
    sessionCache: withOwnValue(current.sessionCache, session.id, session),
    summaries: [toSessionSummary(session), ...current.summaries],
  }))
  moveDraftToSession(session.id)
  return session.id
}

/** 新建会话后把欢迎页的 new 草稿迁到会话键 */
const moveDraftToSession = (sessionId: string) => {
  const draft = getDraft(null)
  if (draft.text || draft.attachments.length > 0) {
    restoreDraft(sessionId, draft.text, draft.attachments)
    clearDraft(null)
  }
  // 欢迎页草稿已经迁走：迟到的欢迎页异步附件解析结果不得再写回
  welcomeDraftRev += 1
}

const buildHistory = (
  session: Session,
  endIndex: number,
  suffix: string
): HistoryMessage[] => {
  const history: HistoryMessage[] = []
  for (let index = 0; index < endIndex; index++) {
    const message = session.messages[index]
    if (!message) {
      continue
    }
    if (isUserMessage(message)) {
      const compacted = message.compact && message.compactText?.trim()
      const text = compacted
        ? message.compactText ?? ''
        : [message.content.trim(), buildAttachmentPrompt(message.attachments)]
            .filter(Boolean)
            .join('\n\n')
      const images = compacted ? [] : collectImageInputs(message.attachments)
      const remoteFiles = compacted ? [] : collectRemoteFiles(message.attachments)
      history.push({
        role: 'user',
        text,
        images: images.length > 0 ? images : undefined,
        remoteFiles: remoteFiles.length > 0 ? remoteFiles : undefined,
      })
    } else if (isAssistantMessage(message)) {
      const compacted = message.compact && message.compactText?.trim()
      const text = compacted ? message.compactText ?? '' : message.content
      if (text.trim()) {
        history.push({ role: 'assistant', text })
      }
    }
  }
  if (suffix.trim() && history.length > 0) {
    const last = history[history.length - 1]
    if (last.role === 'user') {
      last.text = `${last.text}\n\n${suffix}`.trim()
    }
  }
  return history
}

const errorFromStream = (error: unknown): MessageError => {
  if (error instanceof StreamError) {
    return { kind: error.kind, message: error.message, status: error.status, detail: error.detail }
  }
  return {
    kind: 'network',
    message: error instanceof Error ? error.message : String(error),
  }
}

const runReply = async (
  sessionId: string,
  assistantId: string,
  sentRevision?: number
): Promise<void> => {
  const initialSession = getSession(sessionId)
  if (!initialSession) {
    return
  }
  const assistantIndex = initialSession.messages.findIndex((message) => message.id === assistantId)
  if (assistantIndex < 0) {
    return
  }
  const userMessage = [...initialSession.messages.slice(0, assistantIndex)]
    .reverse()
    .find((message): message is UserMessage => isUserMessage(message))
  if (!userMessage) {
    return
  }

  const settings = getSettings()
  const channel = getActiveChannel()
  const slot = settings.activeChannel
  const mode = useConfigStore.getState().mode
  const serverToken = getServerToken()
  const controller = new AbortController()
  // 本轮请求代次：软复位 / 删除会让它失效；同消息重试会替换 entries 里的 attemptId。
  const runEpoch = currentEpoch()
  const attemptId = createId()
  const entry: StreamingEntry = {
    assistantId,
    attemptId,
    controller,
    text: '',
    reasoning: '',
    reasoningStart: null,
    reasoningEnd: null,
    flushTimer: null,
    lastPersist: Date.now(),
  }
  entries.set(sessionId, entry)
  setStreaming(sessionId, true)
  const isCurrentAttempt = (): boolean =>
    !deletedSessions.has(sessionId) &&
    currentEpoch() === runEpoch &&
    entries.get(sessionId)?.attemptId === attemptId
  patchMessage(sessionId, assistantId, {
    status: 'pending',
    content: '',
    reasoning: undefined,
    reasoningMs: undefined,
    error: undefined,
    usage: undefined,
    notice: undefined,
    protocol: channel.protocol,
    slot,
    model: pickModel(channel, settings.thinking),
    channelLabel: channel.label,
  })

  const fail = (message: MessageError, status: ReplyStatus = 'error') => {
    // 旧代次的取消回调绝不能把新发起的重试标成 stopped / aborted
    if (!isCurrentAttempt()) {
      return
    }
    entry.reasoningEnd = entry.reasoningEnd ?? Date.now()
    patchMessage(sessionId, assistantId, {
      content: entry.text,
      reasoning: entry.reasoning || undefined,
      reasoningMs: reasoningSeconds(entry),
      status,
      error: message,
      usage: entry.usage,
      notice: entry.notice,
    })
  }

  try {
    if (mode === 'server') {
      try {
        await ensureConfigSynced()
      } catch {
        // 配置落盘失败时不再发请求：旧 URL 配新密钥会造成难以排查的错配
        fail({ kind: 'config', message: 'configSaveFailed' })
        await persistSession(sessionId)
        return
      }
    }

    let suffix = ''
    const searchEnabled = settings.webSearch && channel.webSearchMode !== 'off'
    if (searchEnabled && channel.webSearchMode === 'exa') {
      const query = userMessage.content.trim()
      if (query) {
        const search = await searchExa({ query, channel, signal: controller.signal })
        // 软复位 / 用户停止后，旧检索的异步返回不得继续拼上下文
        if (controller.signal.aborted) {
          throw new StreamError('aborted', 'aborted by caller')
        }
        if (search.ok && search.results.length > 0) {
          suffix = formatExaContext(query, search.results)
        } else {
          showToast({ key: search.ok ? 'searchEmpty' : 'searchFailedContinue' })
        }
      }
    }
    // 远端 file_id 与当前槽位 / 端点 / 实际生效凭据绑定：任一变化都明确提示重传
    const remoteFingerprint = remoteFileFingerprint(
      slot,
      channel,
      remoteKeyFingerprintOf(slot)
    )
    const staleRemoteAttachment = userMessage.attachments.some(
      (attachment) =>
        attachment.kind === 'remote' &&
        (!channel.enableRemoteFileApi || attachment.remoteEndpoint !== remoteFingerprint)
    )
    if (staleRemoteAttachment) {
      showToast({ key: 'remoteFileStale', type: 'error' })
    }
    if (userMessage.capsule) {
      const capsuleText = resolveCapsuleInstruction(
        userMessage.capsule,
        settings.ui.locale,
        settings.prompts.downstreamLanguage,
        settings.prompts
      )
      suffix = [suffix, capsuleText].filter(Boolean).join('\n\n')
    }

    const history = buildHistory(initialSession, assistantIndex, suffix)
    const systemPrompt = resolveSystemPrompt(settings.ui.locale, settings.prompts)
    const nativeSearch = searchEnabled && channel.webSearchMode === 'native'
    // 纯图片轮次判定只看本轮用户消息本身：历史文字、检索上下文与胶囊指令都不算
    // 用户可发送的文字，否则第二轮单发图片会错误地走“剥离图片重发”分支。
    const latestUserHasText =
      userMessage.content.trim().length > 0 ||
      userMessage.attachments.some(
        (attachment) =>
          (attachment.kind === 'text' || attachment.kind === 'office') &&
          Boolean(attachment.text?.trim())
      )

    await streamChat({
      channel,
      slot,
      mode,
      serverToken,
      history,
      systemPrompt,
      thinking: settings.thinking,
      nativeSearch,
      remoteFingerprint,
      latestUserHasText,
      watchdog: settings.watchdog,
      signal: controller.signal,
      handlers: {
        onDelta: (delta) => {
          // 旧代次（已删除会话 / 已被软复位接管）的流式增量一律静默丢弃
          if (!isCurrentAttempt()) {
            return
          }
          if (delta.text) {
            if (entry.reasoningStart !== null && entry.reasoningEnd === null) {
              entry.reasoningEnd = Date.now()
            }
            entry.text += delta.text
          }
          if (delta.reasoning) {
            if (entry.reasoningStart === null) {
              entry.reasoningStart = Date.now()
            }
            entry.reasoning += delta.reasoning
          }
          scheduleFlush(sessionId)
        },
        onUsage: (usage) => {
          if (!isCurrentAttempt()) {
            return
          }
          // Anthropic 的 usage 分两帧到达：保留 message_start 的 inputTokens，合并 message_delta 的 outputTokens
          entry.usage = mergeUsage(entry.usage, usage)
        },
        onNotice: (notice) => {
          if (!isCurrentAttempt()) {
            return
          }
          entry.notice = notice
          if (notice === 'modality-downgraded') {
            showToast({ key: 'imageOmittedToast' })
          }
        },
      },
    })

    if (!isCurrentAttempt()) {
      // 会话已删除 / 已软复位并换了新代次：本次成功回调不得回写状态或落盘
      return
    }
    if (entry.flushTimer !== null) {
      clearTimeout(entry.flushTimer)
      entry.flushTimer = null
    }
    entry.reasoningEnd = entry.reasoningEnd ?? (entry.reasoningStart !== null ? Date.now() : null)
    patchMessage(sessionId, assistantId, {
      content: entry.text,
      reasoning: entry.reasoning || undefined,
      reasoningMs: reasoningSeconds(entry),
      status: entry.text || entry.reasoning ? 'done' : 'error',
      error:
        entry.text || entry.reasoning
          ? undefined
          : { kind: 'interrupted', message: 'empty response' },
      usage: entry.usage,
      notice: entry.notice,
    })
    await persistSession(sessionId, runEpoch)
  } catch (error) {
    // 会话已删除或已被更新的代次接管：取消 / 失败回调静默收尾，绝不覆盖新一轮状态
    if (!isCurrentAttempt()) {
      return
    }
    if (!(error instanceof StreamError)) {
      fail(errorFromStream(error))
      await persistSession(sessionId, runEpoch)
      return
    }
    if (error.kind === 'aborted') {
      fail({ kind: 'aborted', message: translate('stoppedByUser') }, 'stopped')
      await persistSession(sessionId, runEpoch)
      return
    }
    if (error.kind === 'image-only') {
      // 回滚用户与助手消息；只有用户尚未敲入新草稿时才恢复原草稿（含图片）
      useChatStore.setState((state) => {
        const session = ownValue(state.sessionCache, sessionId)
        if (!session) {
          return state
        }
        const messages = session.messages.filter(
          (message) => message.id !== assistantId && message.id !== userMessage.id
        )
        const next = { ...session, messages, updatedAt: nextUpdatedAt(session.updatedAt) }
        return { sessionCache: withOwnValue(state.sessionCache, sessionId, next) }
      })
      if (sentRevision === undefined || getDraftRevision(sessionId) === sentRevision) {
        restoreDraft(sessionId, userMessage.content, userMessage.attachments)
      }
      showToast({ key: 'errorImageOnly', type: 'error' })
      await persistSession(sessionId, runEpoch)
      return
    }
    fail(errorFromStream(error))
    await persistSession(sessionId, runEpoch)
  } finally {
    const current = entries.get(sessionId)
    // 旧代次的收尾计时器必须无条件清掉：即使新一轮已接管 entries，也不能让旧 timer 触发刷新
    if (entry.flushTimer !== null) {
      clearTimeout(entry.flushTimer)
      entry.flushTimer = null
    }
    // 软复位会先删除 entry 再启动新一轮请求：旧请求收尾时绝不能误解锁新一轮的发送锁
    if (current === entry) {
      entries.delete(sessionId)
      setStreaming(sessionId, false)
    }
  }
}

/** 发送消息；返回是否成功入列（入列后才清空草稿） */
export const sendMessage = (options: {
  text: string
  attachments: Attachment[]
  capsule?: CapsuleId | null
}): boolean => {
  const state = useChatStore.getState()
  if (!state.ready) {
    return false
  }
  if (state.activeId && ownValue(state.streaming, state.activeId) === true) {
    return false
  }
  // http(s) 下本地服务不可达时不发请求，也不降级成静态直连
  const configState = useConfigStore.getState()
  if (!configState.ready) {
    return false
  }
  if (configState.mode === 'server' && configState.offline) {
    showToast({ key: 'serverOfflineBanner', type: 'error' })
    return false
  }
  const text = options.text.trim()
  const usable = options.attachments.filter((attachment) => !isRejectedAttachment(attachment))
  if (!text && usable.length === 0) {
    return false
  }
  const settings = getSettings()
  const slot = settings.activeChannel
  const configError = channelUsable(slot)
  if (configError) {
    showToast({ key: configErrorTranslationKey(configError), type: 'error' })
    return false
  }

  const sessionId = ensureSession(text, usable)
  const session = getSession(sessionId)
  if (!session) {
    return false
  }
  // 发送瞬间的草稿版本号与复位代次：异步落盘 / 草稿恢复回调只有在两者都未变时才允许生效。
  const sentRevision = getDraftRevision(sessionId)
  const sentEpoch = currentEpoch()
  const now = Date.now()
  const userMessage: UserMessage = {
    id: createId(),
    role: 'user',
    content: text,
    attachments: options.attachments,
    capsule: options.capsule ?? undefined,
    createdAt: now,
  }
  const assistantMessage: AssistantMessage = {
    id: createId(),
    role: 'assistant',
    content: '',
    status: 'pending',
    createdAt: now + 1,
    model: pickModel(getActiveChannel(), settings.thinking),
    protocol: getActiveChannel().protocol,
    slot,
    channelLabel: getActiveChannel().label,
  }
  const next: Session = {
    ...session,
    messages: [...session.messages, userMessage, assistantMessage],
    updatedAt: nextUpdatedAt(session.updatedAt),
  }
  setSession(next)
  useChatStore.setState({ pendingCapsule: null })
  // 立即清空输入框；发送副本只保留在本次持久化回调的闭包里。
  // 首次 IndexedDB 落盘失败且用户尚未敲入新字时才恢复，不会误删新草稿；
  // 会话已删除 / 已软复位时绝不恢复，避免已清掉的草稿被旧回调复活。
  clearDraft(sessionId)
  void persistSession(sessionId, sentEpoch).then((saved) => {
    if (
      !saved &&
      !deletedSessions.has(sessionId) &&
      currentEpoch() === sentEpoch &&
      getDraftRevision(sessionId) === sentRevision
    ) {
      restoreDraft(sessionId, text, options.attachments)
    }
  })
  void runReply(sessionId, assistantMessage.id, sentRevision)
  return true
}

export const stopReply = (sessionId: string) => {
  const entry = entries.get(sessionId)
  if (!entry) {
    return
  }
  entry.controller.abort()
}

export const retryAssistant = (
  sessionId: string,
  assistantId: string,
  useBackup = false
): boolean => {
  const state = useChatStore.getState()
  if (ownValue(state.streaming, sessionId) === true) {
    return false
  }
  if (useBackup) {
    const backupError = channelUsable('backup')
    if (backupError) {
      showToast({ key: configErrorTranslationKey(backupError), type: 'error' })
      return false
    }
    if (getSettings().activeChannel !== 'backup') {
      setActiveChannel('backup')
    }
  }
  const session = getSession(sessionId)
  const index = session?.messages.findIndex((item) => item.id === assistantId) ?? -1
  const message = index >= 0 ? session?.messages[index] : undefined
  if (!session || !message || !isAssistantMessage(message)) {
    return false
  }
  // 目标之后还有消息时先截断，避免带着后续轮次重放造成上下文链矛盾
  const trimmed = session.messages.length > index + 1
  if (trimmed) {
    setSession({
      ...session,
      messages: session.messages.slice(0, index + 1),
      updatedAt: nextUpdatedAt(session.updatedAt),
    })
  }
  patchMessage(sessionId, assistantId, {
    content: '',
    reasoning: undefined,
    reasoningMs: undefined,
    error: undefined,
    usage: undefined,
    notice: undefined,
    status: 'pending',
  })
  void persistSession(sessionId)
  if (trimmed) {
    // 延后一拍：调用方随后还会弹“重试已开始”，这里保证截断说明是最后一条提示
    setTimeout(() => {
      try {
        showToast({ key: 'retryTrimmed' })
      } catch {
        // 忽略提示失败
      }
    }, 0)
  }
  void runReply(sessionId, assistantId)
  return true
}

export type RewindResult = 'ok' | 'needs-confirm' | 'blocked'

/**
 * 回滚到某条用户消息之前，并把原消息（含动作胶囊）放回输入框。
 * 输入框已有未发送草稿时返回 needs-confirm，由界面确认后再以 force 执行。
 */
export const rewindTo = (
  sessionId: string,
  userMessageId: string,
  force = false
): RewindResult => {
  if (ownValue(useChatStore.getState().streaming, sessionId) === true) {
    return 'blocked'
  }
  const session = getSession(sessionId)
  if (!session) {
    return 'blocked'
  }
  const index = session.messages.findIndex((message) => message.id === userMessageId)
  if (index < 0) {
    return 'blocked'
  }
  const target = session.messages[index]
  if (!isUserMessage(target)) {
    return 'blocked'
  }
  const currentDraft = getDraft(sessionId)
  const hasUnsentDraft = currentDraft.text.trim().length > 0 || currentDraft.attachments.length > 0
  if (hasUnsentDraft && !force) {
    return 'needs-confirm'
  }
  const next: Session = {
    ...session,
    messages: session.messages.slice(0, index),
    updatedAt: nextUpdatedAt(session.updatedAt),
  }
  setSession(next)
  restoreDraft(sessionId, target.content, target.attachments)
  useChatStore.setState({ pendingCapsule: target.capsule ?? null })
  void persistSession(sessionId)
  return 'ok'
}

/** 带附件时在摘要头部加索引：瘦身后模型看不到原始附件，至少要保留文件名与体积 */
export const buildCompactSummary = (
  text: string,
  marker: string,
  attachments?: Attachment[]
): string => {
  const limit = 1500
  const body =
    text.length <= limit ? text : `${text.slice(0, 1000)}\n\n${marker}\n\n${text.slice(-500)}`
  const items = (attachments ?? [])
    .filter((attachment) => attachment.kind !== 'rejected')
    .map((attachment) => `${attachment.name} (${formatSize(attachment.size)})`)
    .join(', ')
  if (!items) {
    return body
  }
  return `${translate('compactAttachmentIndex', { items })}\n\n${body}`
}

export const setCompact = (
  sessionId: string,
  messageId: string,
  enabled: boolean,
  summary?: string
) => {
  const session = getSession(sessionId)
  const message = session?.messages.find((item) => item.id === messageId)
  if (!message || message.role !== 'user') {
    return
  }
  const compactText =
    summary ??
    buildCompactSummary(message.content, translate('compactDefaultMarker'), message.attachments)
  patchMessage(sessionId, messageId, { compact: enabled, compactText: compactText || undefined })
  void persistSession(sessionId)
}

export const setAssistantCompact = (
  sessionId: string,
  messageId: string,
  enabled: boolean,
  summary?: string
) => {
  const session = getSession(sessionId)
  const message = session?.messages.find((item) => item.id === messageId)
  if (!message || message.role !== 'assistant') {
    return
  }
  const compactText =
    summary ?? buildCompactSummary(message.content, translate('compactDefaultMarker'))
  patchMessage(sessionId, messageId, { compact: enabled, compactText: compactText || undefined })
  void persistSession(sessionId)
}

/**
 * 启动时扫描应急快照并补写回 IndexedDB。
 *
 * 数据库里已有更新记录时说明这条快照已过期，直接丢弃；否则把它并入摘要列表，
 * 补写成功即清键，补写仍失败则保留快照——selectSession 读取正文时还会再用一次。
 */
const recoverUnsavedSessions = async (): Promise<Session[]> => {
  const recovered: Session[] = []
  for (const sessionId of unsavedSessionIds()) {
    const unsaved = readUnsavedSnapshot(sessionId)
    if (!unsaved) {
      removeUnsavedSnapshot(sessionId)
      continue
    }
    let stored: Session | null = null
    try {
      stored = await loadSession(sessionId)
    } catch {
      stored = null
    }
    if (stored && !preferSession(unsaved.session, stored)) {
      // 数据库记录更新（或同毫秒且更完整）：这条应急快照已经过期，直接丢弃
      removeUnsavedSnapshot(sessionId)
      continue
    }
    recovered.push(unsaved.session)
    if (deletedSessions.has(sessionId) || deletingSessions.has(sessionId) || bulkDeleteBarrier) {
      continue
    }
    try {
      await trackSave(saveSession(unsaved.session))
      removeUnsavedSnapshot(sessionId)
    } catch {
      // 补写失败：保留应急键，界面仍从快照渲染完整内容
    }
  }
  return recovered
}

/** 把恢复出的会话摘要并入数据库摘要列表：同 id 取更新时间更新的那一边，其余按更新时间排序 */
const mergeRecoveredSummaries = (
  summaries: SessionSummary[],
  recovered: Session[]
): SessionSummary[] => {
  if (recovered.length === 0) {
    return summaries
  }
  let merged = summaries
  for (const session of recovered) {
    const summary = toSessionSummary(session)
    const existing = merged.find((item) => item.id === session.id)
    merged =
      existing && existing.updatedAt > summary.updatedAt
        ? merged
        : existing
          ? merged.map((item) => (item.id === session.id ? summary : item))
          : [...merged, summary]
  }
  return merged.sort((left, right) => right.updatedAt - left.updatedAt)
}

export const initChat = async (): Promise<void> => {
  try {
    const summaries = await listSessionSummaries()
    const recovered = await recoverUnsavedSessions()
    loadDrafts()
    // 内存缓存里可能还留着“首次落盘就失败、还没进数据库”的会话：摘要也必须补上，
    // 否则刷新或导入后会话列表看不到它，正文却仍占着缓存。
    const cached = Object.values(useChatStore.getState().sessionCache)
    useChatStore.setState({
      ready: true,
      initFailure: null,
      summaries: mergeRecoveredSummaries(mergeRecoveredSummaries(summaries, cached), recovered),
    })
  } catch {
    // IndexedDB 不可用时仍要恢复本地草稿，至少保证输入框可用；同时记录“读取失败”
    // 而不是保存失败，界面据此展示准确的会话读取错误文案。
    loadDrafts()
    useChatStore.setState({ ready: true, initFailure: 'read' })
  }
}

export const selectSession = async (id: string): Promise<void> => {
  // 本轮选择序号：读取返回时若期间又发生过选择 / 复位 / 导入接管，旧回调只能静默退出
  const mySelectSeq = beginSelection()
  const state = useChatStore.getState()
  useChatStore.setState({ activeId: id, pendingCapsule: null })
  if (ownValue(state.sessionCache, id)) {
    return
  }
  // 只记录“全局复位代次 + 本会话自己的版本号”：删除无关会话 B 不会让这里失效，
  // 正在加载的 A 因此不会再被误判为过期而永久卡在 Loading…。
  const startEpoch = currentEpoch()
  const startRev = getSessionRev(id)
  /**
   * 被取代 / 已墓碑化 / 读到的记录不存在时，若界面仍停在该会话的加载态就干净收尾。
   * 只有本轮选择仍是最新选择时才允许清空 activeId：否则把用户后来选中的同 ID 新会话
   * （如删除后重新导入的 A'）误清掉，正文已加载却退回欢迎页。
   */
  const clearDanglingLoading = () => {
    if (mySelectSeq !== selectSeq) {
      return
    }
    const latest = useChatStore.getState()
    if (latest.activeId === id && !ownValue(latest.sessionCache, id)) {
      useChatStore.setState({ activeId: null })
    }
  }
  try {
    const stored = await loadSession(id)
    // 落盘曾连续失败的会话：时间戳更新的应急快照优先于数据库里的半截记录，
    // 读到后立即补写回 IndexedDB，成功才清键；补写失败仍先让界面显示完整正文。
    const unsaved = readUnsavedSnapshot(id)
    const recovered =
      unsaved && preferSession(unsaved.session, stored ?? undefined) ? unsaved.session : null
    const session = recovered ?? stored
    if (!session) {
      clearDanglingLoading()
      return
    }
    // 读取期间该会话可能被删除、被导入覆盖或发生全量复位：只校验本会话版本号、
    // 全局复位代次、墓碑与摘要列表，绝不因无关会话的变动丢弃有效结果。
    const latest = useChatStore.getState()
    if (
      currentEpoch() !== startEpoch ||
      getSessionRev(session.id) !== startRev ||
      deletedSessions.has(session.id) ||
      !latest.summaries.some((summary) => summary.id === session.id)
    ) {
      clearDanglingLoading()
      return
    }
    if (recovered && isPersistTargetAlive(session.id, startEpoch)) {
      void trackSave(saveSession(recovered)).then(
        () => removeUnsavedSnapshot(session.id),
        () => undefined
      )
    }
    useChatStore.setState((current) => ({
      sessionCache: withOwnValue(
        current.sessionCache,
        session.id,
        normalizeLoadedSession(session)
      ),
    }))
  } catch {
    clearDanglingLoading()
    // 仅当本次加载仍是最新选择、目标会话仍存活时才提示：已被取代的旧读取保持安静
    if (
      mySelectSeq === selectSeq &&
      currentEpoch() === startEpoch &&
      getSessionRev(id) === startRev &&
      !deletedSessions.has(id)
    ) {
      // 读取失败不是“保存失败”：提示准确的会话读取错误，避免误导用户去检查保存链路
      showToast({ key: 'sessionReadFailed', type: 'error' })
    }
  }
}

export const startNewChat = () => {
  // 切回欢迎页同样是一次选择态变更：在途读取不得再把旧会话选回来
  beginSelection()
  useChatStore.setState({ activeId: null, pendingCapsule: null })
}

/**
 * 删除单个会话：先落盘成功，再清 UI 与草稿。
 *
 * 顺序不可颠倒：旧实现先把里外状态清干净再删库，一旦 IndexedDB 事务失败 / 被 abort，
 * 用户看到会话已消失、未发草稿也被清空，但库里的记录还在，属于不可恢复的误伤。
 * 现在改为：中止在途流 → 临时写盘屏障 → 排空在途写盘 → 删库 → 成功后才落墓碑、
 * 递增本会话版本号、清 UI 与草稿；失败则解除屏障并保持一切原样，只弹删除失败提示。
 * 只递增 sessionRevs[id]，绝不递增全局代次，因此不会卡死正在加载的其它会话。
 */
export const deleteSession = async (id: string): Promise<void> => {
  deletingSessions.add(id)
  stopReply(id)
  const entry = entries.get(id)
  if (entry && entry.flushTimer !== null) {
    clearTimeout(entry.flushTimer)
    entry.flushTimer = null
  }
  entries.delete(id)
  setStreaming(id, false)
  // 先等在途写盘提交完，再删记录：否则晚创建的保存事务可能在删除之后重新写回
  await waitForPendingSaves()
  try {
    await deleteSessionRecord(id)
  } catch {
    // 数据库事务失败或被 abort：解除屏障，会话列表与用户未发草稿完好无损。
    // 之前被中止的那一轮不能永远停在“生成中”，这里把它标记为已停止。
    deletingSessions.delete(id)
    if (entry) {
      patchMessage(id, entry.assistantId, {
        content: entry.text,
        reasoning: entry.reasoning || undefined,
        reasoningMs: reasoningSeconds(entry),
        status: 'stopped',
      })
    }
    showToast({ key: 'deleteFailed', type: 'error' })
    return
  }
  // 只有 IndexedDB 事务成功 resolve 之后，才允许写入不可恢复的本地状态
  deletedSessions.add(id)
  bumpSessionRev(id)
  clearDraft(id)
  // 会话已确认删除：应急快照也必须同步清掉，否则刷新会把已删会话复活
  removeUnsavedSnapshot(id)
  // 只有删除的正是当前选中会话（activeId 将变为 null）才构成选择态变更；
  // 删除无关会话不递增序号，正在加载的另一个会话不能被误判为过期。
  if (useChatStore.getState().activeId === id) {
    beginSelection()
  }
  useChatStore.setState((state) => ({
    sessionCache: withoutKey(state.sessionCache, id),
    streaming: withoutKey(state.streaming, id),
    summaries: state.summaries.filter((summary) => summary.id !== id),
    activeId: state.activeId === id ? null : state.activeId,
  }))
  deletingSessions.delete(id)
}

/**
 * 备份导入成功后接管新数据：只处理本次真正写入的会话 ID。
 *
 * 严禁清空整个 sessionCache、重置全局代次或中止无关会话的流：后台正在流式生成且带
 * 未发 PNG 草稿的会话 A 必须完全不受影响。对被导入的 id：中止其在途流、递增各自的
 * 版本号（拦截同 ID 旧会话迟到的异步回调）、解除墓碑，并只剔除它们的缓存条目，
 * 随后由调用方按摘要重新加载正文。
 * 返回导入前的当前选中会话 ID，供调用方重新加载正文。
 */
export const adoptImportedSessions = (importedIds: readonly string[]): string | null => {
  // 接管导入会剔除被导入 id 的旧缓存：此前对同 id 发起的在途读取必须作废，
  // 否则旧回调可能清掉随后重新选中的同一会话。
  beginSelection()
  const activeId = useChatStore.getState().activeId
  for (const id of importedIds) {
    stopReply(id)
    const entry = entries.get(id)
    if (entry && entry.flushTimer !== null) {
      clearTimeout(entry.flushTimer)
      entry.flushTimer = null
    }
    entries.delete(id)
    setStreaming(id, false)
    bumpSessionRev(id)
    deletedSessions.delete(id)
    // 同 id 重新导入：旧会话遗留的应急快照属于上一份内容，必须先清掉
    removeUnsavedSnapshot(id)
  }
  const state = useChatStore.getState()
  let sessionCache = state.sessionCache
  for (const id of importedIds) {
    if (ownValue(sessionCache, id) !== undefined) {
      sessionCache = withoutKey(sessionCache, id)
    }
  }
  useChatStore.setState({ sessionCache })
  return activeId
}

/**
 * 异步附件解析的落草稿前活体校验：解析开始后若发生软 / 硬复位（resetEpoch 变化）、
 * 目标会话被删除 / 同 ID 重新导入（sessionRevs 变化）或欢迎页草稿世代变化，
 * 解析结果必须整体丢弃。即便 A 被删除后又导入了同 ID 的 A'，版本号已递增两次，
 * 旧解析结果也会被确定性拦截。
 */
const isDraftWriteTargetAlive = (
  sessionId: string | null,
  epoch: number,
  sessionRev: number
): boolean => {
  if (currentEpoch() !== epoch) {
    return false
  }
  if (sessionId === null) {
    return welcomeDraftRev === sessionRev
  }
  if (deletedSessions.has(sessionId) || getSessionRev(sessionId) !== sessionRev) {
    return false
  }
  const state = useChatStore.getState()
  return (
    ownValue(state.sessionCache, sessionId) !== undefined ||
    state.summaries.some((summary) => summary.id === sessionId)
  )
}

/**
 * 解析完成的附件写进草稿：输入框只走这一个入口，失效目标直接丢弃，
 * 返回是否真正写入，避免已删会话的草稿被异步解析结果复活。
 */
export const addParsedAttachmentIfAlive = (
  sessionId: string | null,
  epoch: number,
  sessionRev: number,
  attachment: Attachment
): boolean => {
  if (!isDraftWriteTargetAlive(sessionId, epoch, sessionRev)) {
    return false
  }
  addDraftAttachment(sessionId, attachment)
  return true
}

export const setPendingCapsule = (capsule: CapsuleId | null) => {
  useChatStore.setState({ pendingCapsule: capsule })
}

/** 软复位：强杀挂起流并清除瞬态，会话 / 草稿 / 配置原样保留 */
export const softReset = () => {
  // 复位后在途读取一律作废，不能再用旧回调清空用户随后选中的会话
  beginSelection()
  const epoch = currentEpoch()
  for (const [sessionId, entry] of entries) {
    entry.controller.abort()
    if (entry.flushTimer !== null) {
      clearTimeout(entry.flushTimer)
      entry.flushTimer = null
    }
    entries.delete(sessionId)
    setStreaming(sessionId, false)
    patchMessage(sessionId, entry.assistantId, {
      content: entry.text,
      reasoning: entry.reasoning || undefined,
      reasoningMs: reasoningSeconds(entry),
      status: entry.text || entry.reasoning ? 'stopped' : 'error',
      error:
        entry.text || entry.reasoning
          ? undefined
          : { kind: 'aborted', message: translate('stoppedByUser') },
    })
    void persistSession(sessionId, epoch)
  }
  useChatStore.setState((state) => ({
    streaming: {},
    pendingCapsule: null,
    resetEpoch: state.resetEpoch + 1,
  }))
  // 旧缓存内容与在途读取一并作废（全量复位才用全局代次）：随后重新点击会话时只能以
  // 数据库最新内容为准。欢迎页草稿没有随复位清空，但它的异步解析世代必须作废。
  welcomeDraftRev += 1
  showToast({ key: 'softResetDone' })
}

/**
 * 删除全部会话（硬复位或数据页使用）：先落盘成功，再清 UI 与草稿。
 *
 * 与单删相同的顺序：中止在途流 → 全量写盘屏障 → 排空在途写盘 → 单事务清库；
 * 只有清库成功后才清空摘要 / 缓存 / 草稿并递增全局代次。清库失败时解除屏障，
 * 会话列表、消息与用户未发草稿保持原样，并弹出明确的删除失败提示。
 */
export const deleteAllSessions = async (): Promise<void> => {
  bulkDeleteBarrier = true
  for (const [sessionId, entry] of entries) {
    entry.controller.abort()
    if (entry.flushTimer !== null) {
      clearTimeout(entry.flushTimer)
      entry.flushTimer = null
    }
    setStreaming(sessionId, false)
  }
  await waitForPendingSaves()
  try {
    await clearAllSessions()
  } catch {
    // 数据库不可用 / 事务被 abort：解除屏障，一切保持原样（绝不清草稿）
    bulkDeleteBarrier = false
    showToast({ key: 'deleteAllFailed', type: 'error' })
    return
  }
  // 清库事务成功 resolve 之后才允许写入不可恢复的本地状态
  const state = useChatStore.getState()
  for (const summary of state.summaries) {
    deletedSessions.add(summary.id)
    bumpSessionRev(summary.id)
  }
  for (const sessionId of Object.keys(state.sessionCache)) {
    deletedSessions.add(sessionId)
    bumpSessionRev(sessionId)
  }
  for (const sessionId of entries.keys()) {
    deletedSessions.add(sessionId)
    bumpSessionRev(sessionId)
  }
  entries.clear()
  welcomeDraftRev += 1
  // 全量删除成功后应急快照同样作废：硬复位 / 清空会话都不允许旧回复在刷新后复活
  clearAllUnsavedSnapshots()
  // 选中态被清空也是一次选择变更：在途读取不得把已删除的会话重新挂回界面
  beginSelection()
  useChatStore.setState((current) => ({
    streaming: {},
    pendingCapsule: null,
    summaries: [],
    sessionCache: {},
    activeId: null,
    resetEpoch: current.resetEpoch + 1,
  }))
  clearAllDrafts()
  bulkDeleteBarrier = false
}

/**
 * 把内存中所有处于 pending / streaming 状态的消息收敛为 stopped，并清空 streaming 锁字典。
 *
 * 中止在途流之后，取消回调会因代次 / 条目失效而不再回写状态；如果紧接着的清库又失败
 * （页面不会重载），消息树里就会残留“生成中”状态，界面上既没有停止按钮也没有重试入口。
 * 这里只收敛状态、保留已到达的半截内容，确保硬复位失败后页面仍可继续操作。
 *
 * 返回本次真正被收敛的会话 ID：流式生成期间 IndexedDB 里的助手消息仍是
 * `status: 'pending', content: ''`，已显示的半截正文只存在于内存中；调用方必须在
 * 破坏性操作之前为这些会话补一次落盘，否则刷新页面就会丢掉这段唯一副本。
 * 收敛同时把 updatedAt 严格递增，保证恢复时不会被数据库里的旧 pending 记录按
 * “更新时间较新者优先”判为过期。
 */
export const settleInterruptedMessages = (): string[] => {
  const state = useChatStore.getState()
  const settled: string[] = []
  let sessionCache = state.sessionCache
  for (const [sessionId, session] of Object.entries(state.sessionCache)) {
    let sessionChanged = false
    const messages = session.messages.map((message) => {
      if (message.role !== 'assistant') {
        return message
      }
      if (message.status !== 'pending' && message.status !== 'streaming') {
        return message
      }
      sessionChanged = true
      return { ...message, status: 'stopped' as ReplyStatus }
    })
    if (!sessionChanged) {
      continue
    }
    if (sessionCache === state.sessionCache) {
      sessionCache = { ...state.sessionCache }
    }
    sessionCache[sessionId] = {
      ...session,
      messages,
      updatedAt: nextUpdatedAt(session.updatedAt),
    }
    settled.push(sessionId)
  }
  if (settled.length === 0) {
    useChatStore.setState({ streaming: {} })
    return settled
  }
  const summaries = state.summaries
    .map((summary) => {
      const next = ownValue(sessionCache, summary.id)
      return next ? toSessionSummary(next) : summary
    })
    .sort((left, right) => right.updatedAt - left.updatedAt)
  useChatStore.setState({ sessionCache, summaries, streaming: {} })
  return settled
}

/**
 * 硬复位阶段一的内部落盘：以调用时的最新 resetEpoch 逐一保存刚收敛的会话。
 * 失败提示被静默（quiet）：硬复位自身已经会按失败原因给出明确提示，内部收敛落盘
 * 再弹一次保存失败只会干扰用户判断；应急快照与 saveError 仍然照常保留。
 */
export const persistSettledSessions = async (sessionIds: readonly string[]): Promise<void> => {
  const epoch = currentEpoch()
  for (const sessionId of sessionIds) {
    await persistSession(sessionId, epoch, { quiet: true })
  }
}

/**
 * 硬复位阶段一：终止所有挂起流、作废在途写盘代次，并把未完成消息收敛为 stopped。
 *
 * 这里只做“停流 + 收敛状态”，绝不动应急快照、草稿或内存会话：紧接着的抢救包导出
 * 仍要从这三处读取完整回复；清库失败时更必须原样保留，刷新后才能恢复。
 *
 * 返回本次收敛过的会话 ID。对流式生成中的会话，已显示的半截正文此前只写入内存
 * （IndexedDB 里还是 pending 空消息），因此这里必须先同步落一份应急快照：即使随后
 * 的抢救包读取连续失败、页面不重载直接刷新，也能从快照恢复完整正文。真正的
 * IndexedDB 落盘由 prepareHardReset() 在排空旧写盘之后调用 persistSettledSessions()
 * 完成，事务若同样被中止，应急快照依然保留。
 * 真正的破坏性清理由 clearLocalStateAfterDatabasePurge() 在 clearDatabase() 成功后执行。
 */
export const beginHardReset = (): string[] => {
  // 硬复位同样作废一切在途读取
  beginSelection()
  const settledIds = new Set<string>()
  for (const [sessionId, entry] of entries) {
    entry.controller.abort()
    if (entry.flushTimer !== null) {
      clearTimeout(entry.flushTimer)
      entry.flushTimer = null
    }
    patchMessage(sessionId, entry.assistantId, {
      content: entry.text,
      reasoning: entry.reasoning || undefined,
      reasoningMs: reasoningSeconds(entry),
      // 硬复位失败时页面不会重载：必须停在可重试的 stopped，而不是“生成中”
      status: 'stopped',
      error:
        entry.text || entry.reasoning
          ? undefined
          : { kind: 'aborted', message: translate('stoppedByUser') },
    })
    entries.delete(sessionId)
    // patchMessage 会为已存在的缓存会话递增 updatedAt；不存在的会话没有可落盘内容
    if (getSession(sessionId)) {
      settledIds.add(sessionId)
    }
  }
  for (const sessionId of settleInterruptedMessages()) {
    settledIds.add(sessionId)
  }
  // 同步应急快照要先于任何 await：后续导出 / 清库都可能被同一类故障注入中止
  for (const sessionId of settledIds) {
    const session = getSession(sessionId)
    if (session) {
      writeUnsavedSnapshot(session)
    }
  }
  useChatStore.setState((state) => ({
    streaming: {},
    pendingCapsule: null,
    resetEpoch: state.resetEpoch + 1,
  }))
  welcomeDraftRev += 1
  return [...settledIds]
}

/** 供消息错误展示：把错误对象映射为界面可读文案与展示参数 */
export const describeMessageError = (
  error: MessageError
): { key: TranslationKey; params: Record<string, string | number> } => {
  const settings = getSettings()
  switch (error.kind) {
    case 'http':
      if (error.message && /cross-origin redirect/i.test(error.message)) {
        return { key: 'errorCrossOriginRedirect', params: {} }
      }
      if (error.status === 401 || error.status === 403) {
        return { key: 'errorAuth', params: { status: error.status } }
      }
      if (error.status === 429) {
        return { key: 'errorRateLimited', params: {} }
      }
      if (error.status === 502 || error.status === 503 || error.status === 504) {
        return { key: 'errorServerBusy', params: { status: error.status } }
      }
      return {
        key: 'errorHttp',
        params: { status: error.status ?? 0, message: error.message },
      }
    case 'network':
      return { key: 'errorNetwork', params: { message: error.message } }
    case 'watchdog':
      return error.message === 'first-byte'
        ? { key: 'errorWatchdogFirstByte', params: { seconds: Math.round(settings.watchdog.firstByteMs / 1000) } }
        : { key: 'errorWatchdogIdle', params: { seconds: Math.round(settings.watchdog.idleMs / 1000) } }
    case 'protocol':
      return { key: 'errorProtocol', params: { message: error.message } }
    case 'stream':
      return { key: 'errorStream', params: { message: error.message } }
    case 'interrupted':
      return { key: 'errorInterrupted', params: {} }
    case 'config':
      return { key: configErrorTranslationKey(error.message), params: {} }
    case 'aborted':
      return { key: 'errorAborted', params: {} }
    case 'image-only':
      return { key: 'errorImageOnly', params: {} }
    default:
      return { key: 'unknownError', params: {} }
  }
}

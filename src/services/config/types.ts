/**
 * 应用配置的数据结构与确定性校验。
 *
 * 设计边界：
 * - 不含任何厂商预设地址或模型枚举，渠道完全由用户填写；
 * - 非敏感设置与密钥分开存放，服务端模式下来自 /api/config，纯静态模式下用 localStorage；
 * - 所有外部输入（服务端返回、localStorage、导入）都经过 sanitize，字段缺失或类型异常时回退默认值。
 */

import { sha256Hex } from '../../utils/sha256.js'

export type Protocol = 'openai' | 'anthropic'
export type ChannelSlot = 'primary' | 'backup'
export type ThinkingParamMode =
  | 'none'
  | 'anthropic_thinking'
  | 'deepseek_thinking'
  | 'openai_reasoning_effort'
  | 'enable_thinking'
export type ModalityMode = 'auto' | 'text_only' | 'multimodal'
export type WebSearchMode = 'off' | 'exa' | 'native'
export type ProxyMode = 'system' | 'direct' | 'custom'
export type Locale = 'en' | 'zh' | 'fr' | 'ru'
export type ThemePreference = 'light' | 'dark' | 'system'
export type ContentWidth = 'standard' | 'wide'
export type DownstreamLanguage = 'follow' | 'en' | 'zh' | 'fr' | 'ru'
export type CapsuleId = 'agent2' | 'agent3' | 'distill'

export const FONT_SCALES = [0.9, 1, 1.12, 1.25] as const
export type FontScale = (typeof FONT_SCALES)[number]

export const LOCALES: readonly Locale[] = ['en', 'zh', 'fr', 'ru']

export interface HeaderPair {
  name: string
  value: string
}

/** 服务端模式下自定义 Header 只回传掩码，明细值留在 secrets.json */
export interface HeaderMask {
  name: string
  mask: string
}

export interface ChannelConfig {
  label: string
  protocol: Protocol
  baseUrl: string
  /** 纯静态直连模式下直接使用的密钥；服务端模式恒为空，密钥在 .console_data/secrets.json */
  apiKey: string
  /** 可选的密钥环境变量名；服务端模式下环境变量非空时优先生效 */
  apiKeyEnv: string
  model: string
  thinkingModel: string
  thinkingParamMode: ThinkingParamMode
  modalityMode: ModalityMode
  webSearchMode: WebSearchMode
  enableRemoteFileApi: boolean
  /** 锁定原始完整 URL，不做任何路径拼接 */
  lockRawUrl: boolean
  proxyMode: ProxyMode
  proxyUrl: string
  allowInsecureTls: boolean
  customHeaders: HeaderPair[]
  temperatureEnabled: boolean
  temperature: number
  maxTokensEnabled: boolean
  maxTokens: number
  /** 上游请求的连接 / 首包超时（秒） */
  requestTimeoutSec: number
}

export interface ExaConfig {
  endpoint: string
  apiKey: string
  apiKeyEnv: string
  numResults: number
}

export interface PromptSettings {
  /** 按界面语言覆盖的系统提示词；缺省时使用内置默认人格 */
  systemPrompt: Partial<Record<Locale, string>>
  /** 按界面语言覆盖的动作胶囊模板；缺省时使用内置默认模板 */
  capsules: Partial<Record<Locale, Partial<Record<CapsuleId, string>>>>
  downstreamLanguage: DownstreamLanguage
}

export interface UiSettings {
  locale: Locale
  themePreference: ThemePreference
  fontScale: FontScale
  contentWidth: ContentWidth
  reduceFlicker: boolean
  siderCollapsed: boolean
}

export interface WatchdogSettings {
  firstByteMs: number
  idleMs: number
}

export interface AppSettings {
  version: 1
  activeChannel: ChannelSlot
  channels: Record<ChannelSlot, ChannelConfig>
  exa: ExaConfig
  prompts: PromptSettings
  ui: UiSettings
  watchdog: WatchdogSettings
  thinking: boolean
  webSearch: boolean
}

export interface SecretMask {
  hasKey: boolean
  /** 服务端检测到同名环境变量非空（环境变量优先于落盘密钥） */
  envSet?: boolean
  /** 末 4 位掩码，如 "...8f2a"；无密钥为空串 */
  mask: string
  /** 实际生效凭据的单向短指纹（sha256 前 12 位十六进制，无密钥为 "none"） */
  keyFingerprint?: string
}

export interface SecretMasks {
  primary: SecretMask
  backup: SecretMask
  exa: SecretMask
  /** 服务端模式：自定义 Header 值只以掩码返回；静态模式为空数组（值直接在 settings 里） */
  customHeaders: Record<ChannelSlot, HeaderMask[]>
}

export type StorageState = 'ok' | 'recovered' | 'missing'

export interface StorageStatus {
  settings: StorageState
  secrets: StorageState
  recovered: boolean
  /** 迁移 / 备份清洗失败等可重试的存储降级告警 */
  degraded: boolean
}

export interface ConfigSnapshot {
  settings: AppSettings
  secrets: SecretMasks
  storage: StorageStatus
}

export interface HealthPayload {
  ok: boolean
  service: 'engineering-ai-console'
  version: string
  bind: string
  port: number
  storage: StorageStatus | null
}

export const CONFIG_VERSION = 1 as const

export const DEFAULT_FIRST_BYTE_MS = 45_000
export const DEFAULT_IDLE_MS = 25_000
export const DEFAULT_REQUEST_TIMEOUT_SEC = 60
export const DEFAULT_MAX_TOKENS = 4096
export const MIN_REQUEST_TIMEOUT_SEC = 5
export const MAX_REQUEST_TIMEOUT_SEC = 600
export const MIN_WATCHDOG_MS = 3_000
export const MAX_WATCHDOG_MS = 600_000
export const MAX_BASE_URL_LENGTH = 2048
export const MAX_HEADER_NAME_LENGTH = 100
export const MAX_HEADER_VALUE_LENGTH = 2048
export const MAX_HEADER_COUNT = 16
export const MAX_CUSTOM_HEADERS_BYTES = 16 * 1024
export const MAX_PROMPT_LENGTH = 20_000
export const MAX_CAPSULE_TEMPLATE_LENGTH = 8_000

export const createChannelConfig = (label: string): ChannelConfig => ({
  label,
  protocol: 'openai',
  baseUrl: '',
  apiKey: '',
  apiKeyEnv: '',
  model: '',
  thinkingModel: '',
  thinkingParamMode: 'none',
  modalityMode: 'auto',
  webSearchMode: 'off',
  enableRemoteFileApi: false,
  lockRawUrl: false,
  proxyMode: 'system',
  proxyUrl: '',
  allowInsecureTls: false,
  customHeaders: [],
  temperatureEnabled: false,
  temperature: 1,
  maxTokensEnabled: false,
  maxTokens: DEFAULT_MAX_TOKENS,
  requestTimeoutSec: DEFAULT_REQUEST_TIMEOUT_SEC,
})

export const createDefaultSettings = (): AppSettings => ({
  version: CONFIG_VERSION,
  activeChannel: 'primary',
  channels: {
    primary: createChannelConfig('Primary'),
    backup: createChannelConfig('Backup'),
  },
  exa: {
    endpoint: 'https://api.exa.ai/search',
    apiKey: '',
    apiKeyEnv: 'EXA_API_KEY',
    numResults: 5,
  },
  prompts: { systemPrompt: {}, capsules: {}, downstreamLanguage: 'follow' },
  ui: {
    locale: 'en',
    themePreference: 'system',
    fontScale: 1,
    contentWidth: 'standard',
    reduceFlicker: true,
    siderCollapsed: false,
  },
  watchdog: { firstByteMs: DEFAULT_FIRST_BYTE_MS, idleMs: DEFAULT_IDLE_MS },
  thinking: false,
  webSearch: false,
})

export const EMPTY_SECRET_MASKS = (): SecretMasks => ({
  primary: { hasKey: false, mask: '' },
  backup: { hasKey: false, mask: '' },
  exa: { hasKey: false, mask: '' },
  customHeaders: { primary: [], backup: [] },
})

export const EMPTY_STORAGE_STATUS = (): StorageStatus => ({
  settings: 'missing',
  secrets: 'missing',
  recovered: false,
  degraded: false,
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asString = (value: unknown, fallback: string, maxLength: number): string =>
  typeof value === 'string' ? value.slice(0, maxLength) : fallback

const asTrimmed = (value: unknown, fallback: string, maxLength: number): string =>
  asString(value, fallback, maxLength).trim()

const asBool = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback

const asNumber = (value: unknown, fallback: number, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }
  return Math.min(max, Math.max(min, value))
}

const asEnum = <T extends string>(value: unknown, fallback: T, allowed: readonly T[]): T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback

const asFontScale = (value: unknown, fallback: FontScale): FontScale =>
  typeof value === 'number' && (FONT_SCALES as readonly number[]).includes(value)
    ? (value as FontScale)
    : fallback

export const sanitizeChannel = (raw: unknown, fallback: ChannelConfig): ChannelConfig => {
  if (!isRecord(raw)) {
    return { ...fallback, customHeaders: [] }
  }
  const headers: HeaderPair[] = []
  if (Array.isArray(raw.customHeaders)) {
    let bytes = 0
    for (const item of raw.customHeaders.slice(0, MAX_HEADER_COUNT)) {
      if (!isRecord(item)) {
        continue
      }
      const name = asTrimmed(item.name, '', MAX_HEADER_NAME_LENGTH)
      const value = asString(item.value, '', MAX_HEADER_VALUE_LENGTH).trim()
      if (!name || !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) {
        continue
      }
      const size = name.length + value.length
      if (bytes + size > MAX_CUSTOM_HEADERS_BYTES) {
        break
      }
      bytes += size
      headers.push({ name, value })
    }
  }
  const protocol = asEnum<Protocol>(raw.protocol, fallback.protocol, ['openai', 'anthropic'])
  return {
    label: asTrimmed(raw.label, fallback.label, 80) || fallback.label,
    protocol,
    baseUrl: asTrimmed(raw.baseUrl, fallback.baseUrl, MAX_BASE_URL_LENGTH),
    apiKey: asString(raw.apiKey, '', 4096),
    apiKeyEnv: asTrimmed(raw.apiKeyEnv, fallback.apiKeyEnv, 120),
    model: asTrimmed(raw.model, fallback.model, 240),
    thinkingModel: asTrimmed(raw.thinkingModel, fallback.thinkingModel, 240),
    thinkingParamMode: asEnum<ThinkingParamMode>(raw.thinkingParamMode, fallback.thinkingParamMode, [
      'none',
      'anthropic_thinking',
      'deepseek_thinking',
      'openai_reasoning_effort',
      'enable_thinking',
    ]),
    modalityMode: asEnum<ModalityMode>(raw.modalityMode, fallback.modalityMode, [
      'auto',
      'text_only',
      'multimodal',
    ]),
    webSearchMode: asEnum<WebSearchMode>(raw.webSearchMode, fallback.webSearchMode, [
      'off',
      'exa',
      'native',
    ]),
    enableRemoteFileApi: asBool(raw.enableRemoteFileApi, fallback.enableRemoteFileApi),
    lockRawUrl: asBool(raw.lockRawUrl, fallback.lockRawUrl),
    proxyMode: asEnum<ProxyMode>(raw.proxyMode, fallback.proxyMode, ['system', 'direct', 'custom']),
    proxyUrl: asTrimmed(raw.proxyUrl, fallback.proxyUrl, MAX_BASE_URL_LENGTH),
    allowInsecureTls: asBool(raw.allowInsecureTls, fallback.allowInsecureTls),
    customHeaders: headers,
    temperatureEnabled: asBool(raw.temperatureEnabled, fallback.temperatureEnabled),
    temperature: asNumber(raw.temperature, fallback.temperature, 0, 2),
    maxTokensEnabled: asBool(raw.maxTokensEnabled, fallback.maxTokensEnabled),
    maxTokens: Math.round(asNumber(raw.maxTokens, fallback.maxTokens, 1, 2_000_000)),
    requestTimeoutSec: Math.round(
      asNumber(
        raw.requestTimeoutSec,
        fallback.requestTimeoutSec,
        MIN_REQUEST_TIMEOUT_SEC,
        MAX_REQUEST_TIMEOUT_SEC
      )
    ),
  }
}

const sanitizeLocaleMap = (raw: unknown, maxLength: number): Partial<Record<Locale, string>> => {
  const result: Partial<Record<Locale, string>> = {}
  if (!isRecord(raw)) {
    return result
  }
  for (const locale of LOCALES) {
    const value = raw[locale]
    if (typeof value === 'string' && value.trim()) {
      result[locale] = value.slice(0, maxLength)
    }
  }
  return result
}

const sanitizePromptSettings = (raw: unknown, fallback: PromptSettings): PromptSettings => {
  if (!isRecord(raw)) {
    return { ...fallback, systemPrompt: {}, capsules: {} }
  }
  const capsules: Partial<Record<Locale, Partial<Record<CapsuleId, string>>>> = {}
  if (isRecord(raw.capsules)) {
    for (const locale of LOCALES) {
      const item = raw.capsules[locale]
      if (isRecord(item)) {
        const entry: Partial<Record<CapsuleId, string>> = {}
        for (const id of ['agent2', 'agent3', 'distill'] as const) {
          const value = item[id]
          if (typeof value === 'string' && value.trim()) {
            entry[id] = value.slice(0, MAX_CAPSULE_TEMPLATE_LENGTH)
          }
        }
        if (Object.keys(entry).length > 0) {
          capsules[locale] = entry
        }
      }
    }
  }
  return {
    systemPrompt: sanitizeLocaleMap(raw.systemPrompt, MAX_PROMPT_LENGTH),
    capsules,
    downstreamLanguage: asEnum<DownstreamLanguage>(raw.downstreamLanguage, fallback.downstreamLanguage, [
      'follow',
      'en',
      'zh',
      'fr',
      'ru',
    ]),
  }
}

export const sanitizeSettings = (raw: unknown): AppSettings => {
  const base = createDefaultSettings()
  if (!isRecord(raw)) {
    return base
  }
  const channelsRaw = isRecord(raw.channels) ? raw.channels : {}
  const exaRaw = isRecord(raw.exa) ? raw.exa : {}
  const uiRaw = isRecord(raw.ui) ? raw.ui : {}
  const watchdogRaw = isRecord(raw.watchdog) ? raw.watchdog : {}
  return {
    version: CONFIG_VERSION,
    activeChannel: asEnum<ChannelSlot>(raw.activeChannel, base.activeChannel, ['primary', 'backup']),
    channels: {
      primary: sanitizeChannel(channelsRaw.primary, base.channels.primary),
      backup: sanitizeChannel(channelsRaw.backup, base.channels.backup),
    },
    exa: {
      endpoint: asTrimmed(exaRaw.endpoint, base.exa.endpoint, MAX_BASE_URL_LENGTH),
      apiKey: asString(exaRaw.apiKey, '', 4096),
      apiKeyEnv: asTrimmed(exaRaw.apiKeyEnv, base.exa.apiKeyEnv, 120),
      numResults: Math.round(asNumber(exaRaw.numResults, base.exa.numResults, 1, 10)),
    },
    prompts: sanitizePromptSettings(raw.prompts, base.prompts),
    ui: {
      locale: asEnum<Locale>(uiRaw.locale, base.ui.locale, LOCALES),
      themePreference: asEnum<ThemePreference>(uiRaw.themePreference, base.ui.themePreference, [
        'light',
        'dark',
        'system',
      ]),
      fontScale: asFontScale(uiRaw.fontScale, base.ui.fontScale),
      contentWidth: asEnum<ContentWidth>(uiRaw.contentWidth, base.ui.contentWidth, [
        'standard',
        'wide',
      ]),
      reduceFlicker: asBool(uiRaw.reduceFlicker, base.ui.reduceFlicker),
      siderCollapsed: asBool(uiRaw.siderCollapsed, base.ui.siderCollapsed),
    },
    watchdog: {
      firstByteMs: Math.round(
        asNumber(watchdogRaw.firstByteMs, base.watchdog.firstByteMs, MIN_WATCHDOG_MS, MAX_WATCHDOG_MS)
      ),
      idleMs: Math.round(
        asNumber(watchdogRaw.idleMs, base.watchdog.idleMs, MIN_WATCHDOG_MS, MAX_WATCHDOG_MS)
      ),
    },
    thinking: asBool(raw.thinking, base.thinking),
    webSearch: asBool(raw.webSearch, base.webSearch),
  }
}

/** 读取密钥掩码：仅保留末 4 位，绝不返回明文 */
export const maskSecret = (secret: string): SecretMask =>
  secret
    ? { hasKey: true, mask: `...${secret.slice(-4)}` }
    : { hasKey: false, mask: '' }

/**
 * 实际生效凭据的单向短指纹，与 server.py 的 sha256(...)[:12] 完全一致。
 * 纯静态模式下前端自己算，服务端模式下直接用 /api/config 下发的值。
 */
export const secretFingerprint = (secret: string): string => {
  const trimmed = secret.trim()
  return trimmed ? sha256Hex(trimmed).slice(0, 12) : 'none'
}

/** 静态模式的密钥展示结构：掩码 + 与实际生效凭据一致的指纹 */
export const maskSecretWithFingerprint = (secret: string): SecretMask => ({
  ...maskSecret(secret),
  keyFingerprint: secretFingerprint(secret),
})

const secretFingerprintOf = (raw: unknown): string | undefined => {
  if (typeof raw !== 'string') {
    return undefined
  }
  const value = raw.trim()
  return /^(?:[0-9a-f]{12}|none)$/.test(value) ? value : undefined
}

const asSecretMask = (raw: unknown): SecretMask => {
  if (!isRecord(raw)) {
    return { hasKey: false, mask: '' }
  }
  const keyFingerprint = secretFingerprintOf(raw.keyFingerprint)
  return {
    hasKey: asBool(raw.hasKey, false),
    envSet: raw.envSet === true ? true : undefined,
    mask: asString(raw.mask, '', 32),
    ...(keyFingerprint === undefined ? {} : { keyFingerprint }),
  }
}

const sanitizeHeaderMasks = (raw: unknown): HeaderMask[] => {
  if (!Array.isArray(raw)) {
    return []
  }
  const result: HeaderMask[] = []
  for (const item of raw.slice(0, MAX_HEADER_COUNT)) {
    if (!isRecord(item)) {
      continue
    }
    const name = asTrimmed(item.name, '', MAX_HEADER_NAME_LENGTH)
    if (!name) {
      continue
    }
    result.push({ name, mask: asString(item.mask, '', MAX_HEADER_VALUE_LENGTH) })
  }
  return result
}

/** /api/config 的密钥段也是外部输入，统一收敛；缺失时回退为“无密钥” */
export const sanitizeSecretMasks = (raw: unknown): SecretMasks => {
  const base = EMPTY_SECRET_MASKS()
  if (!isRecord(raw)) {
    return base
  }
  const headers = isRecord(raw.customHeaders) ? raw.customHeaders : {}
  return {
    primary: asSecretMask(raw.primary),
    backup: asSecretMask(raw.backup),
    exa: asSecretMask(raw.exa),
    customHeaders: {
      primary: sanitizeHeaderMasks(headers.primary),
      backup: sanitizeHeaderMasks(headers.backup),
    },
  }
}

export const sanitizeStorageStatus = (raw: unknown): StorageStatus => {
  const base = EMPTY_STORAGE_STATUS()
  if (!isRecord(raw)) {
    return base
  }
  const state = (value: unknown): StorageState =>
    value === 'ok' || value === 'recovered' || value === 'missing' ? value : 'missing'
  return {
    settings: state(raw.settings),
    secrets: state(raw.secrets),
    recovered: asBool(raw.recovered, false),
    degraded: asBool(raw.degraded, false),
  }
}

const isHttpOrigin = (value: string): boolean => {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/** 基础地址仅允许 http/https，避免 file:、javascript: 等协议进入请求链路 */
export const isHttpUrl = (value: string): boolean => isHttpOrigin(value.trim())

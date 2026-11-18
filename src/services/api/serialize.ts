/**
 * 中立消息 → 上游协议请求体的动态序列化。
 *
 * 关键约束：
 * - OpenAI 协议下，只要本轮不含内联图片，messages[].content 必须是纯 string（不发票数组），
 *   以兼容所有纯文本模型与严苛推理网关；
 * - 会话历史只保留用户文字与助手正文，思考过程不回传，切换到另一协议可无损接续上下文；
 * - 任何 message 的 content 都不得为空串或空数组：被省略的图片 / 附件一律留下英文说明，
 *   整条消息没有可发送内容时用占位说明兜底，避免上游 400；
 * - 渠道私有字段（联网工具、思考参数）由渠道配置决定，绝不写死厂商值。
 */

import {
  DEFAULT_MAX_TOKENS,
  type ChannelConfig,
  type ThinkingParamMode,
} from '../config/types.js'
import type { HistoryMessage, RemoteFileRef, SerializedRequest } from './types.js'
import { normalizeChatUrl, normalizeFilesUrl, type UrlError } from './url.js'

export type SerializeFailure = {
  ok: false
  error: UrlError | 'emptyModel' | 'invalidHeaders'
}

export type SerializeResult = { ok: true; request: SerializedRequest } | SerializeFailure

export const IMAGE_OMITTED_NOTICE = (name: string) =>
  `[System Notice: Image '${name}' was omitted because the active model only accepts text input]`

export const REMOTE_FILE_OMITTED_NOTICE = (name: string) =>
  `[System Notice: Attachment '${name}' is only available through the Anthropic Files API and was omitted for this channel protocol]`

export const REMOTE_FILE_STALE_NOTICE = (name: string) =>
  `[System Notice: Attachment '${name}' was uploaded through a different channel endpoint and was not sent. Re-upload it for the current channel]`

export const EMPTY_CONTENT_NOTICE =
  '[System Notice: This message contained no sendable text or attachments after local processing; it is kept as an empty-content placeholder so the conversation stays structurally valid]'

/** Anthropic 扩展思考：默认预算与 max_tokens 下限；max_tokens 必须严格大于 budget_tokens */
export const ANTHROPIC_THINKING_BUDGET = 8192
const ANTHROPIC_THINKING_MAX_TOKENS = 16000
const MIN_THINKING_BUDGET = 1024

const applyThinkingParams = (
  body: Record<string, unknown>,
  mode: ThinkingParamMode
): Record<string, unknown> => {
  switch (mode) {
    case 'anthropic_thinking':
      return { ...body, thinking: { type: 'enabled', budget_tokens: ANTHROPIC_THINKING_BUDGET } }
    case 'deepseek_thinking':
      return { ...body, thinking: { type: 'enabled' } }
    case 'openai_reasoning_effort':
      return { ...body, reasoning_effort: 'high' }
    case 'enable_thinking':
      return { ...body, enable_thinking: true }
    default:
      return body
  }
}

/**
 * Anthropic 扩展思考的 token 预算分配。
 * 未自定义 maxTokens 时用宽松默认；自定义值不足以容纳思考预算时收缩 budget，
 * 极端情况下（maxTokens <= 1024）反过来抬高 max_tokens，保证严格大于 budget_tokens。
 */
export const anthropicThinkingTokens = (
  channel: ChannelConfig
): { maxTokens: number; budgetTokens: number } => {
  const budgetTokens = ANTHROPIC_THINKING_BUDGET
  if (!channel.maxTokensEnabled) {
    return { maxTokens: ANTHROPIC_THINKING_MAX_TOKENS, budgetTokens }
  }
  const requested = channel.maxTokens
  if (requested > budgetTokens) {
    return { maxTokens: requested, budgetTokens }
  }
  const shrunk = Math.max(MIN_THINKING_BUDGET, requested - 1024)
  return shrunk >= requested
    ? { maxTokens: shrunk + 1024, budgetTokens: shrunk }
    : { maxTokens: requested, budgetTokens: shrunk }
}

const splitDataUrl = (dataUrl: string): { mediaType: string; base64: string } => {
  const comma = dataUrl.indexOf(',')
  const header = comma >= 0 ? dataUrl.slice(5, comma) : ''
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : ''
  const mediaType = header.split(';')[0] || 'image/png'
  return { mediaType, base64 }
}

/** 当前通道的 Files API 地址；未开启远端文件接口时为 null */
const filesEndpointOf = (channel: ChannelConfig): string | null => {
  if (!channel.enableRemoteFileApi) {
    return null
  }
  const url = normalizeFilesUrl(channel)
  return url.ok ? url.url : null
}

const usableRemoteFiles = (
  message: HistoryMessage,
  filesEndpoint: string | null,
  fingerprint: string | null
): RemoteFileRef[] => {
  const expected = fingerprint ?? filesEndpoint
  return expected
    ? (message.remoteFiles ?? []).filter((file) => file.endpoint === expected)
    : []
}

/**
 * 把被省略的图片 / 附件说明拼到消息文字里。
 * 图片省略说明无条件生效（只要本轮不带图），远端文件说明区分「协议不支持」与「通道端点已变更」。
 */
const withOmittedNotices = (
  message: HistoryMessage,
  includeImages: boolean,
  remoteFilesAllowed: boolean,
  filesEndpoint: string | null,
  fingerprint: string | null
): string => {
  const expected = fingerprint ?? filesEndpoint
  const notices: string[] = []
  if (!includeImages) {
    for (const image of message.images ?? []) {
      notices.push(IMAGE_OMITTED_NOTICE(image.name))
    }
  }
  for (const file of message.remoteFiles ?? []) {
    if (!remoteFilesAllowed) {
      notices.push(REMOTE_FILE_OMITTED_NOTICE(file.name))
    } else if (!expected || file.endpoint !== expected) {
      notices.push(REMOTE_FILE_STALE_NOTICE(file.name))
    }
  }
  return [message.text, ...notices].filter((part) => part.trim()).join('\n')
}

const textPart = (text: string) => ({ type: 'text' as const, text })

const openAiContent = (message: HistoryMessage, includeImages: boolean) => {
  const images = includeImages ? (message.images ?? []) : []
  const text = withOmittedNotices(message, includeImages, false, null, null)
  if (images.length === 0) {
    return text
  }
  return [
    ...(text.trim() ? [textPart(text)] : []),
    ...images.map((image) => ({ type: 'image_url' as const, image_url: { url: image.dataUrl } })),
  ]
}

const anthropicContent = (
  message: HistoryMessage,
  includeImages: boolean,
  remoteFilesAllowed: boolean,
  filesEndpoint: string | null,
  fingerprint: string | null
) => {
  const images = includeImages ? (message.images ?? []) : []
  // 远端接口关闭时绝不能发出 document/file_id：历史里残留的归属指纹不能当作放行依据，
  // 否则关掉开关后旧附件仍会以远端块形式送到上游。
  const remoteFiles = remoteFilesAllowed
    ? usableRemoteFiles(message, filesEndpoint, fingerprint)
    : []
  const text = withOmittedNotices(message, includeImages, remoteFilesAllowed, filesEndpoint, fingerprint)
  if (images.length === 0 && remoteFiles.length === 0) {
    return text
  }
  return [
    ...(text.trim() ? [textPart(text)] : []),
    ...images.map((image) => {
      const { mediaType, base64 } = splitDataUrl(image.dataUrl)
      return {
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: mediaType, data: base64 },
      }
    }),
    ...remoteFiles.map((file) => ({
      type: 'document' as const,
      source: { type: 'file' as const, file_id: file.fileId },
    })),
  ]
}

const openAiBody = (
  channel: ChannelConfig,
  history: HistoryMessage[],
  systemPrompt: string,
  thinking: boolean,
  includeImages: boolean
): Record<string, unknown> => {
  const messages: Array<Record<string, unknown>> = [
    { role: 'system', content: systemPrompt },
    ...history.map((message) => ({
      role: message.role,
      content: openAiContent(message, includeImages),
    })),
  ]
  let body: Record<string, unknown> = {
    model: pickModel(channel, thinking),
    messages,
    stream: true,
  }
  if (channel.temperatureEnabled) {
    body.temperature = channel.temperature
  }
  if (channel.maxTokensEnabled) {
    body.max_tokens = channel.maxTokens
  }
  if (thinking) {
    body = applyThinkingParams(body, channel.thinkingParamMode)
  }
  return body
}

const anthropicBody = (
  channel: ChannelConfig,
  history: HistoryMessage[],
  systemPrompt: string,
  thinking: boolean,
  includeImages: boolean,
  nativeSearch: boolean,
  remoteFingerprint: string | null
): Record<string, unknown> => {
  const remoteFilesAllowed = channel.enableRemoteFileApi
  const filesEndpoint = filesEndpointOf(channel)
  const messages = history.map((message) => ({
    role: message.role,
    content: anthropicContent(
      message,
      includeImages,
      remoteFilesAllowed,
      filesEndpoint,
      remoteFingerprint
    ),
  }))
  const useAnthropicThinking = thinking && channel.thinkingParamMode === 'anthropic_thinking'
  let maxTokens = channel.maxTokensEnabled ? channel.maxTokens : DEFAULT_MAX_TOKENS
  let thinkingBudget: number | null = null
  if (useAnthropicThinking) {
    const tokens = anthropicThinkingTokens(channel)
    maxTokens = tokens.maxTokens
    thinkingBudget = tokens.budgetTokens
  }
  let body: Record<string, unknown> = {
    model: pickModel(channel, thinking),
    system: systemPrompt,
    messages,
    stream: true,
    max_tokens: maxTokens,
  }
  // Anthropic 扩展思考与 temperature 互斥：启用 thinking 时官方 API 会拒绝自定义温度，直接忽略
  if (channel.temperatureEnabled && !useAnthropicThinking) {
    body.temperature = channel.temperature
  }
  if (nativeSearch) {
    body.tools = [
      { type: 'deepseek_web_search', name: 'deepseek_web_search' },
      { type: 'deepseek_read_url', name: 'deepseek_read_url' },
    ]
  }
  if (thinking) {
    body = applyThinkingParams(body, channel.thinkingParamMode)
    if (thinkingBudget !== null) {
      body.thinking = { type: 'enabled', budget_tokens: thinkingBudget }
    }
  }
  return body
}

/** 出口统一守卫：任何 message 的 content 为空串 / 空数组 / 缺失时注入占位说明 */
const guardMessageContents = (body: Record<string, unknown>) => {
  const messages = body.messages
  if (!Array.isArray(messages)) {
    return
  }
  for (const item of messages) {
    if (typeof item !== 'object' || item === null) {
      continue
    }
    const message = item as Record<string, unknown>
    const content = message.content
    if (content === undefined || content === '' || (Array.isArray(content) && content.length === 0)) {
      message.content = EMPTY_CONTENT_NOTICE
    }
  }
}

export const pickModel = (channel: ChannelConfig, thinking: boolean): string => {
  const thinkingModel = channel.thinkingModel.trim()
  return thinking && thinkingModel ? thinkingModel : channel.model.trim()
}

export interface SerializeOptions {
  history: HistoryMessage[]
  systemPrompt: string
  thinking: boolean
  /** 仅 anthropic 协议支持原项目服务端原生检索工具链 */
  nativeSearch: boolean
  includeImages: boolean
  /** 远端文件归属指纹（槽位 + 规范化 Files URL + 密钥提示）；缺省时退回端点 URL 比对 */
  remoteFingerprint?: string | null
  /**
   * 本轮最新一条用户消息是否含可发送文字（用户原文或文本类附件）。
   * 缺省时由 history 里最后一条用户消息推断；纯图片轮次必须为 false。
   */
  latestUserHasText?: boolean
}

export const serializeChatRequest = (
  channel: ChannelConfig,
  options: SerializeOptions
): SerializeResult => {
  const model = pickModel(channel, options.thinking)
  if (!model) {
    return { ok: false, error: 'emptyModel' }
  }
  const url = normalizeChatUrl(channel)
  if (!url.ok) {
    return { ok: false, error: url.error }
  }
  const hadImages = options.includeImages && options.history.some((message) => (message.images?.length ?? 0) > 0)
  // 只认“本轮最新一条用户消息”的文字：历史里早就有十轮文字，也不能把本轮的纯图片
  // 判成“有文字可降级”，否则会剥离图片重发并把纯图片拒止误报成成功回复。
  // 调用方（会话层）能区分用户原文与胶囊 / 检索后缀，优先采用它的判定。
  const latestUser = [...options.history]
    .reverse()
    .find((message) => message.role === 'user')
  const hasText =
    options.latestUserHasText ?? Boolean(latestUser && latestUser.text.trim().length > 0)
  const nativeSearch = options.nativeSearch && channel.protocol === 'anthropic'
  const body =
    channel.protocol === 'openai'
      ? openAiBody(channel, options.history, options.systemPrompt, options.thinking, options.includeImages)
      : anthropicBody(
          channel,
          options.history,
          options.systemPrompt,
          options.thinking,
          options.includeImages,
          nativeSearch,
          options.remoteFingerprint ?? null
        )
  guardMessageContents(body)
  return {
    ok: true,
    request: { url: url.url, protocol: channel.protocol, body, hadImages, hasText, model },
  }
}

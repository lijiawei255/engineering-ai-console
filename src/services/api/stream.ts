/**
 * OpenAI / Anthropic 双协议流解析与传输看门狗。
 *
 * 容错边界：
 * - 单行脏 JSON、SSE 注释心跳直接跳过，不影响后续 token；
 * - 兼容 delta.reasoning_content / delta.reasoning 与正文里的 think 标签（只认回复起始的开标签）；
 * - [DONE] / message_stop 是终止标志，收到即主动取消底层 reader 退出；
 * - OpenAI finish_reason 视为有效完成标志，但仍继续读完 usage；
 * - 正常 EOF 却没有任何完成标志时抛 interrupted，已输出的内容保留；
 * - 首包与包间断流看门狗超时立即 abort，抛出可识别的 watchdog 错误；
 * - 首包前 429/502/503/504 自动退避 1.2 秒重试一次；
 * - 多模态请求收到 400/415/422 且通道为 auto 时，剥离图片并以纯文本重发一次；
 *   但如果本轮最新一条用户消息只有图片（无文字、无文本类附件），绝不重发，
 *   而是抛 image-only 让会话层回滚该轮并恢复图片草稿。
 */

import type { ChannelConfig, ChannelSlot, WatchdogSettings } from '../config/types.js'
import { translate } from '../../i18n/index.js'
import { directRequestHeaders } from './headers.js'
import { readServerSentEvents, type ServerSentEvent } from './sse.js'
import { serializeChatRequest, type SerializeOptions } from './serialize.js'
import {
  StreamError,
  type HistoryMessage,
  type SerializedRequest,
  type StreamDelta,
  type UsageInfo,
} from './types.js'

// ---------------------------------------------------------------------------
// 单帧解析（纯函数，便于自检）
// ---------------------------------------------------------------------------

export interface ParsedFrame {
  text?: string
  reasoning?: string
  usage?: UsageInfo
  /** 终止标志：[DONE] / message_stop，收到后立即停止读取 */
  done?: boolean
  /** 语义完成标志：OpenAI finish_reason，允许继续读 usage */
  finish?: boolean
  error?: string
}

const pickUsage = (raw: unknown): UsageInfo | undefined => {
  if (typeof raw !== 'object' || raw === null) {
    return undefined
  }
  const value = raw as Record<string, unknown>
  const numberOrUndefined = (key: string) =>
    typeof value[key] === 'number' ? (value[key] as number) : undefined
  const input = numberOrUndefined('prompt_tokens') ?? numberOrUndefined('input_tokens')
  const output = numberOrUndefined('completion_tokens') ?? numberOrUndefined('output_tokens')
  return input === undefined && output === undefined ? undefined : { inputTokens: input, outputTokens: output }
}

/**
 * Anthropic 把 usage 拆成两帧：message_start 只带 input_tokens（output_tokens 为 0/1），
 * message_delta 只带 output_tokens。逐帧覆盖会让流结束后的输入计数归零，因此按字段合并。
 */
export const mergeUsage = (
  previous: UsageInfo | undefined,
  next: UsageInfo | undefined
): UsageInfo | undefined => {
  if (!previous) {
    return next
  }
  if (!next) {
    return previous
  }
  return {
    inputTokens: next.inputTokens ?? previous.inputTokens,
    outputTokens: next.outputTokens ?? previous.outputTokens,
  }
}

const errorMessageOf = (value: unknown): string | undefined => {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const record = value as Record<string, unknown>
  const error = record.error
  if (typeof error === 'string') {
    return error
  }
  if (typeof error === 'object' && error !== null) {
    const message = (error as Record<string, unknown>).message
    if (typeof message === 'string') {
      return message
    }
  }
  // 部分网关（例如 SiliconFlow）把错误摊平在顶层：{"code":30014,"message":"Token is invalid."}
  // 只在这种载荷明确长得像错误时才认，避免把正常回复里的同名字段误判成错误。
  if (typeof record.message === 'string' && record.message.trim() && record.error === undefined) {
    const looksLikeError =
      record.code !== undefined ||
      record.type === 'error' ||
      record.object === 'error' ||
      record.status === 'error' ||
      record.success === false
    if (looksLikeError) {
      return record.message
    }
  }
  return undefined
}

/** OpenAI 的 content 既可能是纯字符串，也可能是 [{type:'text',text:'...'}] 分段数组 */
const textOfContent = (raw: unknown): string | undefined => {
  if (typeof raw === 'string') {
    return raw
  }
  if (!Array.isArray(raw)) {
    return undefined
  }
  const parts: string[] = []
  for (const part of raw) {
    if (typeof part === 'string') {
      parts.push(part)
    } else if (typeof part === 'object' && part !== null) {
      const text = (part as Record<string, unknown>).text
      if (typeof text === 'string') {
        parts.push(text)
      }
    }
  }
  return parts.join('') || undefined
}

/** OpenAI Chat Completions SSE 帧 */
export const parseOpenAiEvent = (data: string): ParsedFrame | null => {
  const trimmed = data.trim()
  if (!trimmed) {
    return null
  }
  if (trimmed === '[DONE]') {
    return { done: true }
  }
  let payload: unknown
  try {
    payload = JSON.parse(trimmed)
  } catch {
    // 单行脏 JSON 容错跳过
    return null
  }
  const error = errorMessageOf(payload)
  if (error) {
    return { error }
  }
  if (typeof payload !== 'object' || payload === null) {
    return null
  }
  const frame = payload as Record<string, unknown>
  const choices = Array.isArray(frame.choices) ? frame.choices : []
  const choice = (choices[0] ?? {}) as Record<string, unknown>
  const deltaRaw = choice.delta
  const delta =
    typeof deltaRaw === 'object' && deltaRaw !== null
      ? (deltaRaw as Record<string, unknown>)
      : undefined
  const text =
    textOfContent(delta?.content) ??
    textOfContent((choice.message as Record<string, unknown> | undefined)?.content) ??
    (typeof choice.text === 'string' ? choice.text : undefined)
  const reasoning =
    (typeof delta?.reasoning_content === 'string' ? delta.reasoning_content : undefined) ??
    (typeof delta?.reasoning === 'string' ? delta.reasoning : undefined)
  const result: ParsedFrame = {}
  if (text) {
    result.text = text
  }
  if (reasoning) {
    result.reasoning = reasoning
  }
  if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
    result.finish = true
  }
  const usage = pickUsage(frame.usage)
  if (usage) {
    result.usage = usage
  }
  return Object.keys(result).length > 0 ? result : null
}

/** Anthropic Messages SSE 帧 */
export const parseAnthropicEvent = (eventName: string, data: string): ParsedFrame | null => {
  const trimmed = data.trim()
  if (!trimmed) {
    return eventName === 'error' ? { error: translate('errorUpstreamStream') } : null
  }
  let payload: unknown
  try {
    payload = JSON.parse(trimmed)
  } catch {
    if (eventName === 'error') {
      return { error: trimmed.slice(0, 500) }
    }
    return null
  }
  const error = errorMessageOf(payload)
  if (error) {
    return { error }
  }
  if (typeof payload !== 'object' || payload === null) {
    return null
  }
  const frame = payload as Record<string, unknown>
  const type = typeof frame.type === 'string' ? frame.type : eventName
  if (type === 'message_stop') {
    return { done: true }
  }
  if (type === 'message_start') {
    const message = frame.message
    const usage =
      typeof message === 'object' && message !== null
        ? pickUsage((message as Record<string, unknown>).usage)
        : undefined
    return usage ? { usage } : null
  }
  if (type === 'message_delta') {
    const usage = pickUsage(frame.usage)
    return usage ? { usage } : null
  }
  if (type === 'content_block_delta') {
    const delta =
      typeof frame.delta === 'object' && frame.delta !== null
        ? (frame.delta as Record<string, unknown>)
        : {}
    if (delta.type === 'text_delta' && typeof delta.text === 'string') {
      return { text: delta.text }
    }
    if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      return { reasoning: delta.thinking }
    }
    return null
  }
  if (type === 'content_block_start') {
    const block =
      typeof frame.content_block === 'object' && frame.content_block !== null
        ? (frame.content_block as Record<string, unknown>)
        : {}
    if (block.type === 'text' && typeof block.text === 'string' && block.text) {
      return { text: block.text }
    }
    if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
      return { reasoning: block.thinking }
    }
    return null
  }
  if (type === 'error') {
    return { error: trimmed.slice(0, 500) }
  }
  return null
}

/**
 * 兼容“网关忽略 stream:true”的一次性响应体：整段 JSON 错误体、JSON 完整回复或纯文本。
 *
 * 真实网关经常在流式请求上返回 HTTP 200 + application/json（鉴权失败/参数不合法时尤其
 * 常见）。若把它当 SSE 解析，一个事件都读不到，最后只能报“流提前结束”，用户完全看不出
 * 真正原因。这里把它归一成与 SSE 相同的 ParsedFrame。
 */
export const parseNonSseBody = (body: string): ParsedFrame | null => {
  const trimmed = body.trim()
  if (!trimmed) {
    return null
  }
  let payload: unknown
  try {
    payload = JSON.parse(trimmed)
  } catch {
    // 非 JSON 文本按一次性正文处理，至少不让整轮对话变成“解析失败”
    return { text: trimmed, done: true }
  }
  if (typeof payload !== 'object' || payload === null) {
    return null
  }
  const frame = payload as Record<string, unknown>
  const error = errorMessageOf(payload)
  if (error) {
    return { error }
  }
  const choices = Array.isArray(frame.choices) ? frame.choices : []
  const choice = (choices[0] ?? {}) as Record<string, unknown>
  const message =
    typeof choice.message === 'object' && choice.message !== null
      ? (choice.message as Record<string, unknown>)
      : undefined
  const text = message ? textOfContent(message.content) : textOfContent(choice.text)
  const reasoning = message
    ? (textOfContent(message.reasoning_content) ?? textOfContent(message.reasoning))
    : undefined
  const usage = pickUsage(frame.usage)
  if (!text && !reasoning && !usage) {
    return null
  }
  const result: ParsedFrame = { done: true }
  if (text) {
    result.text = text
  }
  if (reasoning) {
    result.reasoning = reasoning
  }
  if (usage) {
    result.usage = usage
  }
  return result
}

// ---------------------------------------------------------------------------
// 正文里的 think 标签状态机
//
// 只认回复起始位置（可跳过前导空白）的开标签：模型偶尔在正文里引用字面标签，
// 不能把后续正文误吞进思考区。正文态的孤立闭合标签按原文输出。
// ---------------------------------------------------------------------------

const OPEN_TAGS = ['<think>', '<thinking>'] as const
const CLOSE_TAGS = ['</think>', '</thinking>'] as const

const longestSuffixPrefix = (buffer: string, markers: readonly string[]): number => {
  let keep = 0
  for (const marker of markers) {
    const max = Math.min(buffer.length, marker.length - 1)
    for (let length = max; length > keep; length--) {
      if (buffer.endsWith(marker.slice(0, length))) {
        keep = length
        break
      }
    }
  }
  return keep
}

const findCloseTag = (buffer: string): { index: number; length: number } | null => {
  let best: { index: number; length: number } | null = null
  for (const tag of CLOSE_TAGS) {
    const index = buffer.indexOf(tag)
    if (index >= 0 && (best === null || index < best.index)) {
      best = { index, length: tag.length }
    }
  }
  return best
}

const LEADING_WHITESPACE = /^[\s\uFEFF]*/

export class ThinkTagSplitter {
  private state: 'start' | 'text' | 'thinking' = 'start'
  private buffer = ''

  push(chunk: string): StreamDelta[] {
    this.buffer += chunk
    const output: StreamDelta[] = []
    for (;;) {
      if (this.state === 'start') {
        const leading = LEADING_WHITESPACE.exec(this.buffer)?.[0] ?? ''
        const rest = this.buffer.slice(leading.length)
        // 只有空白时先等后续分片：开标签可能跨块到达，空白是否保留取决于后面是不是标签
        if (!rest) {
          this.buffer = leading
          return output
        }
        const openTag = OPEN_TAGS.find((tag) => rest.startsWith(tag))
        if (openTag) {
          this.buffer = rest.slice(openTag.length)
          this.state = 'thinking'
          continue
        }
        if (OPEN_TAGS.some((tag) => tag.startsWith(rest))) {
          // 整个剩余部分都是开标签前缀，继续等下一块
          this.buffer = leading + rest
          return output
        }
        // 起始位置不是开标签：前导空白与正文一起输出，之后不再识别开标签
        if (leading) {
          output.push({ text: leading })
        }
        this.buffer = rest
        this.state = 'text'
        continue
      }
      if (this.state === 'thinking') {
        const close = findCloseTag(this.buffer)
        if (close) {
          if (close.index > 0) {
            output.push({ reasoning: this.buffer.slice(0, close.index) })
          }
          this.buffer = this.buffer.slice(close.index + close.length)
          this.state = 'text'
          continue
        }
        const keep = longestSuffixPrefix(this.buffer, CLOSE_TAGS)
        const emit = this.buffer.slice(0, this.buffer.length - keep)
        if (emit) {
          output.push({ reasoning: emit })
        }
        this.buffer = this.buffer.slice(this.buffer.length - keep)
        return output
      }
      // 正文态：开标签不再有特殊含义，孤立闭合标签原样输出
      if (this.buffer) {
        output.push({ text: this.buffer })
        this.buffer = ''
      }
      return output
    }
  }

  end(): StreamDelta[] {
    const output: StreamDelta[] = []
    if (this.buffer) {
      output.push(this.state === 'thinking' ? { reasoning: this.buffer } : { text: this.buffer })
    }
    this.buffer = ''
    return output
  }
}

// ---------------------------------------------------------------------------
// 传输看门狗与请求编排
// ---------------------------------------------------------------------------

export type StreamMode = 'server' | 'static'

export type StreamNotice = 'modality-downgraded'

export interface StreamHandlers {
  onDelta: (delta: StreamDelta) => void
  onUsage?: (usage: UsageInfo) => void
  onNotice?: (notice: StreamNotice) => void
}

export interface StreamChatOptions {
  channel: ChannelConfig
  slot: ChannelSlot
  mode: StreamMode
  serverToken: string
  history: HistoryMessage[]
  systemPrompt: string
  thinking: boolean
  nativeSearch: boolean
  /** 远端文件归属指纹（槽位 + Files URL + 实际生效凭据指纹） */
  remoteFingerprint: string
  /** 本轮最新一条用户消息是否有文字（纯图片轮次为 false，历史文字不参与判定） */
  latestUserHasText?: boolean
  watchdog: WatchdogSettings
  signal: AbortSignal
  handlers: StreamHandlers
}

const MAX_REQUEST_BYTES = 32 * 1024 * 1024 - 64 * 1024
const MAX_ERROR_BODY = 8 * 1024
// 非流式一次性回复可能比错误体大得多（整段回答），但仍然要有明确上限
const MAX_NON_SSE_BODY = 4 * 1024 * 1024
const bodyEncoder = new TextEncoder()

interface AttemptContext {
  watchdog: 'first-byte' | 'idle' | null
}

const httpErrorMessage = async (response: Response): Promise<string> => {
  const text = (await response.text().catch(() => '')).slice(0, MAX_ERROR_BODY)
  try {
    const payload: unknown = JSON.parse(text)
    const message = errorMessageOf(payload)
    if (message) {
      return message
    }
  } catch {
    // 非 JSON 错误体直接使用截断原文
  }
  return text.trim() || response.statusText || `HTTP ${response.status}`
}

const isTransientStatus = (status: number | undefined): boolean =>
  status === 429 || status === 502 || status === 503 || status === 504

const isModalityStatus = (status: number | undefined): boolean =>
  status === 400 || status === 415 || status === 422

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const serializeOptionsOf = (
  options: StreamChatOptions,
  includeImages: boolean
): SerializeOptions => ({
  history: options.history,
  systemPrompt: options.systemPrompt,
  thinking: options.thinking,
  nativeSearch: options.nativeSearch,
  includeImages,
  remoteFingerprint: options.remoteFingerprint,
  latestUserHasText: options.latestUserHasText,
})

export const streamChat = async (options: StreamChatOptions): Promise<void> => {
  let downgraded = false
  let transientRetried = false

  const build = (includeImages: boolean): SerializedRequest => {
    const serialized = serializeChatRequest(options.channel, serializeOptionsOf(options, includeImages))
    if (!serialized.ok) {
      throw new StreamError('config', String(serialized.error))
    }
    const bodyText = JSON.stringify(
      options.mode === 'server'
        ? { slot: options.slot, payload: serialized.request.body }
        : serialized.request.body
    )
    // 请求体大小按真实 UTF-8 字节数判定：中文与 emoji 的字符数明显小于字节数
    if (bodyEncoder.encode(bodyText).length > MAX_REQUEST_BYTES) {
      throw new StreamError('config', 'payloadTooLarge')
    }
    return serialized.request
  }

  const runAttempt = async (request: SerializedRequest): Promise<void> => {
    const controller = new AbortController()
    const abortFromCaller = () => controller.abort(options.signal.reason)
    if (options.signal.aborted) {
      controller.abort(options.signal.reason)
    } else {
      options.signal.addEventListener('abort', abortFromCaller, { once: true })
    }
    const context: AttemptContext = { watchdog: null }
    let firstByteTimer: ReturnType<typeof setTimeout> | undefined
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const clearTimers = () => {
      if (firstByteTimer !== undefined) {
        clearTimeout(firstByteTimer)
        firstByteTimer = undefined
      }
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer)
        idleTimer = undefined
      }
    }
    const armWatchdog = (kind: 'first-byte' | 'idle') => {
      clearTimers()
      const timeout = kind === 'first-byte' ? options.watchdog.firstByteMs : options.watchdog.idleMs
      const timer = setTimeout(() => {
        context.watchdog = kind
        controller.abort(new Error(`watchdog:${kind}`))
      }, timeout)
      if (kind === 'first-byte') {
        firstByteTimer = timer
      } else {
        idleTimer = timer
      }
    }
    armWatchdog('first-byte')

    const splitter = new ThinkTagSplitter()
    const emitParts = (parts: StreamDelta[]) => {
      for (const part of parts) {
        if (part.text) {
          options.handlers.onDelta({ text: part.text })
        }
        if (part.reasoning) {
          options.handlers.onDelta({ reasoning: part.reasoning })
        }
      }
    }

    const feedText = (text: string) => {
      emitParts(splitter.push(text))
    }

    let completed = false
    let terminated = false

    const handleFrame = (frame: ParsedFrame) => {
      if (frame.error) {
        throw new StreamError('stream', frame.error, undefined, frame.error)
      }
      if (frame.usage) {
        options.handlers.onUsage?.(frame.usage)
      }
      if (frame.reasoning) {
        options.handlers.onDelta({ reasoning: frame.reasoning })
      }
      if (frame.text) {
        feedText(frame.text)
      }
      if (frame.finish) {
        completed = true
      }
      if (frame.done) {
        completed = true
        terminated = true
      }
    }

    const handleEvent = (event: ServerSentEvent) => {
      const frame =
        request.protocol === 'openai'
          ? parseOpenAiEvent(event.data)
          : parseAnthropicEvent(event.event, event.data)
      if (frame) {
        handleFrame(frame)
      }
    }

    try {
      const serverBody =
        options.mode === 'server'
          ? { slot: options.slot, payload: request.body }
          : request.body
      const response = await fetch(
        options.mode === 'server' ? '/api/chat/stream' : request.url,
        {
          method: 'POST',
          headers:
            options.mode === 'server'
              ? { 'Content-Type': 'application/json', 'X-Console-Token': options.serverToken }
              : directRequestHeaders(options.channel),
          body: JSON.stringify(serverBody),
          signal: controller.signal,
          cache: 'no-store',
        }
      )
      if (!response.ok) {
        throw new StreamError('http', await httpErrorMessage(response), response.status)
      }
      if (!response.body) {
        throw new StreamError('protocol', translate('errorEmptyBody'))
      }
      const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
      if (!contentType.includes('text/event-stream')) {
        // 网关无视 stream:true：HTTP 200 + JSON 错误体 / 完整 JSON 回复 / 纯文本。
        // 一次读完再解析，绝不能送进 SSE 读取器等一个永远不会到来的事件。
        const rawText = (await response.text().catch(() => '')).slice(0, MAX_NON_SSE_BODY)
        const frame = parseNonSseBody(rawText)
        if (!frame) {
          throw new StreamError(
            'protocol',
            rawText.slice(0, 300) || translate('errorEmptyBody')
          )
        }
        if (frame.error) {
          throw new StreamError('http', frame.error, response.status, frame.error)
        }
        handleFrame(frame)
        return
      }
      try {
        // 统一走 sse.ts 的事件读取器；break/抛错都会触发其 finally 取消底层 reader
        const events = readServerSentEvents(response.body, {
          signal: controller.signal,
          onChunk: () => {
            // 收到任意字节（含保活注释）即视为首包到达，并重置空闲看门狗
            armWatchdog('idle')
          },
        })
        for await (const event of events) {
          handleEvent(event)
          if (terminated) {
            break
          }
        }
      } catch (error) {
        // 流中途失败：取消读取并中止底层请求，避免半开连接继续占资源
        if (!controller.signal.aborted) {
          controller.abort(new Error('stream aborted after error'))
        }
        emitParts(splitter.end())
        throw error
      }
      emitParts(splitter.end())
      if (!completed) {
        // 中止或看门狗触发时底层 reader 会以 done 收尾，这里要先把真实原因报出去
        if (options.signal.aborted) {
          throw new StreamError('aborted', 'aborted by caller')
        }
        if (context.watchdog) {
          throw new StreamError('watchdog', context.watchdog)
        }
        throw new StreamError('interrupted', 'stream ended before a completion marker')
      }
    } catch (error) {
      if (error instanceof StreamError) {
        throw error
      }
      if (context.watchdog) {
        throw new StreamError('watchdog', context.watchdog)
      }
      if (options.signal.aborted) {
        throw new StreamError('aborted', 'aborted by caller')
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new StreamError('watchdog', 'aborted')
      }
      if (error instanceof Error && error.name === 'TypeError') {
        throw new StreamError('network', error.message)
      }
      throw new StreamError('network', error instanceof Error ? error.message : String(error))
    } finally {
      clearTimers()
      options.signal.removeEventListener('abort', abortFromCaller)
    }
  }

  let includeImages = options.channel.modalityMode !== 'text_only'
  for (;;) {
    let request: SerializedRequest
    try {
      request = build(includeImages)
    } catch (error) {
      if (error instanceof StreamError) {
        throw error
      }
      throw new StreamError('config', String(error))
    }
    try {
      await runAttempt(request)
      return
    } catch (error) {
      if (!(error instanceof StreamError)) {
        throw error
      }
      if (error.kind === 'aborted') {
        throw error
      }
      if (error.kind === 'http' && isTransientStatus(error.status) && !transientRetried) {
        transientRetried = true
        await delay(1200)
        continue
      }
      if (
        error.kind === 'http' &&
        isModalityStatus(error.status) &&
        options.channel.modalityMode === 'auto' &&
        request.hadImages &&
        !downgraded
      ) {
        if (!request.hasText) {
          // 本轮最新用户消息是纯图片：历史里的旧文字不能当作“可降级”的依据
          throw new StreamError('image-only', error.message, error.status, error.detail)
        }
        downgraded = true
        includeImages = false
        options.handlers.onNotice?.('modality-downgraded')
        // 同一轮只降级重发一次
        continue
      }
      throw error
    }
  }
}

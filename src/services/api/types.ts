import type { Protocol } from '../config/types.js'

export interface ImageInput {
  name: string
  mediaType: string
  /** data:image/png;base64,.... */
  dataUrl: string
}

export interface RemoteFileRef {
  fileId: string
  name: string
  mediaType: string
  /** 上传时使用的 Files API 地址指纹；与当前通道不一致时不能复用 file_id */
  endpoint?: string
}

export interface HistoryMessage {
  role: 'user' | 'assistant'
  text: string
  images?: ImageInput[]
  remoteFiles?: RemoteFileRef[]
}

export interface UsageInfo {
  inputTokens?: number
  outputTokens?: number
}

export interface StreamDelta {
  text?: string
  reasoning?: string
}

export type StreamErrorKind =
  | 'http'
  | 'network'
  | 'protocol'
  | 'stream'
  | 'interrupted'
  | 'watchdog'
  | 'image-only'
  | 'aborted'
  | 'config'

export class StreamError extends Error {
  constructor(
    readonly kind: StreamErrorKind,
    message: string,
    readonly status?: number,
    readonly detail?: string
  ) {
    super(message)
    this.name = 'StreamError'
  }
}

export interface SerializedRequest {
  url: string
  protocol: Protocol
  body: Record<string, unknown>
  /** 本次请求是否携带内联图片 */
  hadImages: boolean
  /**
   * 本轮最新一条用户消息是否有可发送文字（用户原文或文本类附件）。
   * 纯图片轮次为 false，哪怕更早的历史里有大量文字。
   */
  hasText: boolean
  model: string
}

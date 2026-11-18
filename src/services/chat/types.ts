import type { Attachment } from '../attachments/index.js'
import type { CapsuleId, ChannelSlot, Protocol } from '../config/types.js'
import type { StreamErrorKind, UsageInfo } from '../api/types.js'

export type ReplyStatus = 'pending' | 'streaming' | 'done' | 'stopped' | 'error'

export interface MessageError {
  kind: StreamErrorKind
  /** 面向界面的原文或配置错误码 */
  message: string
  status?: number
  detail?: string
}

export interface UserMessage {
  id: string
  role: 'user'
  content: string
  attachments: Attachment[]
  /** 发送时选中的单次动作胶囊 */
  capsule?: CapsuleId
  createdAt: number
  /** 上下文瘦身：界面保留原文，后续请求改用 compactText */
  compact?: boolean
  compactText?: string
}

export interface AssistantMessage {
  id: string
  role: 'assistant'
  content: string
  reasoning?: string
  reasoningMs?: number
  status: ReplyStatus
  createdAt: number
  model?: string
  protocol?: Protocol
  slot?: ChannelSlot
  channelLabel?: string
  error?: MessageError
  usage?: UsageInfo
  /** 多模态降级提示 */
  notice?: 'modality-downgraded'
  compact?: boolean
  compactText?: string
}

export type ChatMessage = UserMessage | AssistantMessage

export interface Session {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
}

export type SessionSummary = Pick<Session, 'id' | 'title' | 'createdAt' | 'updatedAt'>

export const toSessionSummary = (session: Session): SessionSummary => ({
  id: session.id,
  title: session.title,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
})

export const isUserMessage = (message: ChatMessage): message is UserMessage =>
  message.role === 'user'

export const isAssistantMessage = (message: ChatMessage): message is AssistantMessage =>
  message.role === 'assistant'

/** 把恢复出来的半截流状态收敛为可展示状态 */
export const normalizeLoadedSession = (session: Session): Session => ({
  ...session,
  messages: session.messages.map((message) => {
    if (message.role !== 'assistant') {
      return message
    }
    if (message.status === 'pending' || message.status === 'streaming') {
      return {
        ...message,
        status: 'stopped' as const,
        error: { kind: 'interrupted' as const, message: 'stream interrupted by page reload' },
      }
    }
    return message
  }),
})

/** 会话标题取首条用户消息前 60 个字符 */
export const deriveTitle = (text: string, fallback: string): string => {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return fallback
  }
  return normalized.length > 60 ? `${normalized.slice(0, 60)}…` : normalized
}

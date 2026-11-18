/**
 * 会话备份与恢复。
 *
 * 两种产物：
 * - 纯文本抢救包：供人阅读，包含完整消息树与本地附件抽取文本；
 * - 结构化 JSON：供本程序重新导入，只含会话数据，绝不含 settings / API Key / token。
 *
 * 读取默认走 loadSessionsForBackup()：它把 IndexedDB 记录、localStorage 应急快照与内存
 * sessionCache 按会话 ID 合并取最新完整状态，因此首次写库就失败、只存在于应急快照或
 * 内存里的会话也会完整出现在导出中。纯文本导出仍可通过注入的 loadAll 在 Node 自检里
 * 直接传入内存会话验证。
 */

import { translate } from '../../i18n/index.js'
import { formatSize, type Attachment, type AttachmentError, type AttachmentKind } from '../attachments/index.js'
import { importSessionsAtomically, type AtomicImportResult } from './db.js'
import { loadSessionsForBackup } from './store.js'
import {
  isAssistantMessage,
  isUserMessage,
  type AssistantMessage,
  type ChatMessage,
  type MessageError,
  type ReplyStatus,
  type Session,
  type UserMessage,
} from './types.js'

/** 导入预算：文件大小、会话数、消息总数与合法时间戳区间 */
export const MAX_JSON_BACKUP_BYTES = 32 * 1024 * 1024
export const MAX_JSON_BACKUP_SESSIONS = 2_000
export const MAX_JSON_BACKUP_MESSAGES = 50_000
export const MAX_TIMESTAMP_MS = 8_640_000_000_000_000

export interface PlainTextBackupResult {
  text: string
  sessionCount: number
  messageCount: number
}

const attachmentIndex = (attachments: Attachment[]): string =>
  attachments.map((attachment) => `${attachment.name} (${formatSize(attachment.size)})`).join(', ')

/** 时间戳安全格式化：单条历史脏数据不得阻断整库纯文本抢救导出 */
const isoTimestamp = (value: number): string => {
  if (!Number.isFinite(value) || value < 0 || value > MAX_TIMESTAMP_MS) {
    return '(invalid timestamp)'
  }
  try {
    return new Date(value).toISOString()
  } catch {
    return '(invalid timestamp)'
  }
}

const isValidTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_TIMESTAMP_MS

const appendUserMessage = (lines: string[], message: UserMessage) => {
  lines.push(`### ${translate('exportFieldUser')} (${isoTimestamp(message.createdAt)})`)
  if (message.content) {
    lines.push(message.content)
  }
  if (message.attachments.length > 0) {
    lines.push(
      translate('exportFieldAttachments', { items: attachmentIndex(message.attachments) })
    )
    for (const attachment of message.attachments) {
      const text = attachment.text?.trim()
      if (!text) {
        continue
      }
      lines.push(
        translate('exportAttachmentBlock', { name: attachment.name, size: attachment.size })
      )
      lines.push(text)
    }
  }
  lines.push('')
}

const appendAssistantMessage = (lines: string[], message: AssistantMessage) => {
  lines.push(`### ${translate('exportFieldAgent')} (${isoTimestamp(message.createdAt)})`)
  lines.push(translate('exportFieldStatus', { status: message.status }))
  if (message.content) {
    lines.push(message.content)
  }
  lines.push('')
}

/** 纯文本抢救包：异步合并 IndexedDB / 应急快照 / 内存缓存，本地附件文本一并导出。
 *  默认读取入口启用严格完整性守卫：全库读取失败时宁可抛错中止导出，也不生成残缺包。
 *  自检需要直接注入内存会话时仍可传入自定义 loadAll。 */
export const buildPlainTextBackup = async (
  loadAll: () => Promise<Session[]> = () =>
    loadSessionsForBackup({ requireCompleteDbRead: true })
): Promise<PlainTextBackupResult> => {
  const sessions = await loadAll()
  const lines: string[] = [
    translate('exportPlainTextHeader'),
    translate('exportFieldGenerated', { time: new Date().toISOString() }),
    '',
  ]
  let messageCount = 0
  for (const session of sessions) {
    lines.push(`## ${session.title}`)
    lines.push(translate('exportFieldSession', { id: session.id }))
    lines.push('')
    for (const message of session.messages) {
      messageCount += 1
      if (isUserMessage(message)) {
        appendUserMessage(lines, message)
      } else if (isAssistantMessage(message)) {
        appendAssistantMessage(lines, message)
      }
    }
  }
  return { text: lines.join('\n'), sessionCount: sessions.length, messageCount }
}

// ---------------------------------------------------------------------------
// JSON 备份
// ---------------------------------------------------------------------------

export const JSON_BACKUP_SCHEMA = 'engineering-ai-console/session-backup' as const

export interface JsonBackup {
  schema: typeof JSON_BACKUP_SCHEMA
  version: 1
  exportedAt: string
  sessions: Session[]
}

/** 只保留已知字段再写出：即使内存对象被塞了额外属性，也不会进备份文件 */
const pickAttachment = (attachment: Attachment): Attachment => ({
  id: attachment.id,
  name: attachment.name,
  size: attachment.size,
  mime: attachment.mime,
  kind: attachment.kind,
  text: attachment.text,
  truncated: attachment.truncated,
  originalBytes: attachment.originalBytes,
  dataUrl: attachment.dataUrl,
  mediaType: attachment.mediaType,
  remoteFileId: attachment.remoteFileId,
  remoteChannel: attachment.remoteChannel,
  remoteEndpoint: attachment.remoteEndpoint,
  limitMb: attachment.limitMb,
  error: attachment.error,
  errorDetail: attachment.errorDetail,
})

const pickUserMessage = (message: UserMessage): UserMessage => ({
  id: message.id,
  role: 'user',
  content: message.content,
  attachments: message.attachments.map(pickAttachment),
  capsule: message.capsule,
  createdAt: message.createdAt,
  compact: message.compact,
  compactText: message.compactText,
})

const pickAssistantMessage = (message: AssistantMessage): AssistantMessage => ({
  id: message.id,
  role: 'assistant',
  content: message.content,
  reasoning: message.reasoning,
  reasoningMs: message.reasoningMs,
  status: message.status,
  createdAt: message.createdAt,
  model: message.model,
  protocol: message.protocol,
  slot: message.slot,
  channelLabel: message.channelLabel,
  error: message.error ? { ...message.error } : undefined,
  usage: message.usage ? { ...message.usage } : undefined,
  notice: message.notice,
  compact: message.compact,
  compactText: message.compactText,
})

const pickMessage = (message: ChatMessage): ChatMessage =>
  isUserMessage(message) ? pickUserMessage(message) : pickAssistantMessage(message)

const pickSession = (session: Session): Session => ({
  id: session.id,
  title: session.title,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  messages: session.messages.map(pickMessage),
})

/** 结构化备份对象：只含会话，不含任何配置或密钥 */
export const buildJsonBackup = (sessions: Session[]): JsonBackup => ({
  schema: JSON_BACKUP_SCHEMA,
  version: 1,
  exportedAt: new Date().toISOString(),
  sessions: sessions.map(pickSession),
})

/**
 * 结构化备份的合并读取入口：与纯文本抢救包使用同一套三源合并规则与严格完整性守卫，
 * 保证应急快照 / 仅内存会话也会完整进入 JSON 备份，而数据库读取失败时绝不产出残缺文件。
 */
export const buildJsonBackupFromSources = async (): Promise<JsonBackup> =>
  buildJsonBackup(await loadSessionsForBackup({ requireCompleteDbRead: true }))

// ---------------------------------------------------------------------------
// JSON 解析与校验
// ---------------------------------------------------------------------------

const ATTACHMENT_KINDS: readonly AttachmentKind[] = ['text', 'office', 'image', 'remote', 'rejected']
const ATTACHMENT_ERRORS: readonly string[] = [
  'tooLarge',
  'unsupported',
  'readFailed',
  'officeFailed',
  'binaryUnsupported',
  'remoteFailed',
  'needsRemote',
  'officeTooLarge',
  'imageUnsupported',
]
const REPLY_STATUSES: readonly ReplyStatus[] = ['pending', 'streaming', 'done', 'stopped', 'error']

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

const parseAttachment = (raw: unknown): Attachment | null => {
  if (!isRecord(raw)) {
    return null
  }
  if (
    !isNonEmptyString(raw.id) ||
    !isNonEmptyString(raw.name) ||
    !isFiniteNumber(raw.size) ||
    typeof raw.mime !== 'string' ||
    !ATTACHMENT_KINDS.includes(raw.kind as AttachmentKind)
  ) {
    return null
  }
  const dataUrl = optionalString(raw.dataUrl)
  const attachment: Attachment = {
    id: raw.id,
    name: raw.name,
    size: raw.size,
    mime: raw.mime,
    kind: raw.kind as AttachmentKind,
  }
  if (raw.text !== undefined) {
    if (typeof raw.text !== 'string') {
      return null
    }
    attachment.text = raw.text
  }
  if (typeof raw.truncated === 'boolean') {
    attachment.truncated = raw.truncated
  }
  if (isFiniteNumber(raw.originalBytes)) {
    attachment.originalBytes = raw.originalBytes
  }
  // 只接受内嵌图片 data URL；备份文件不能把任意 URL 带进消息渲染
  if (dataUrl && dataUrl.startsWith('data:image/')) {
    attachment.dataUrl = dataUrl
  }
  const mediaType = optionalString(raw.mediaType)
  if (mediaType) {
    attachment.mediaType = mediaType
  }
  const remoteFileId = optionalString(raw.remoteFileId)
  if (remoteFileId) {
    attachment.remoteFileId = remoteFileId
  }
  const remoteEndpoint = optionalString(raw.remoteEndpoint)
  if (remoteEndpoint) {
    attachment.remoteEndpoint = remoteEndpoint
  }
  if (raw.remoteChannel === 'primary' || raw.remoteChannel === 'backup') {
    attachment.remoteChannel = raw.remoteChannel
  }
  if (isFiniteNumber(raw.limitMb)) {
    attachment.limitMb = raw.limitMb
  }
  const error = optionalString(raw.error)
  if (error && ATTACHMENT_ERRORS.includes(error)) {
    attachment.error = error as AttachmentError
  }
  const errorDetail = optionalString(raw.errorDetail)
  if (errorDetail) {
    attachment.errorDetail = errorDetail
  }
  return attachment
}

const parseMessageError = (raw: unknown): MessageError | undefined => {
  if (!isRecord(raw) || !isNonEmptyString(raw.kind) || typeof raw.message !== 'string') {
    return undefined
  }
  const error: MessageError = {
    kind: raw.kind as MessageError['kind'],
    message: raw.message,
  }
  if (isFiniteNumber(raw.status)) {
    error.status = raw.status
  }
  const detail = optionalString(raw.detail)
  if (detail) {
    error.detail = detail
  }
  return error
}

const parseUserMessage = (raw: Record<string, unknown>): UserMessage | null => {
  if (!isNonEmptyString(raw.id) || typeof raw.content !== 'string' || !isValidTimestamp(raw.createdAt)) {
    return null
  }
  if (!Array.isArray(raw.attachments)) {
    return null
  }
  const attachments: Attachment[] = []
  for (const item of raw.attachments) {
    const attachment = parseAttachment(item)
    if (!attachment) {
      return null
    }
    attachments.push(attachment)
  }
  const message: UserMessage = {
    id: raw.id,
    role: 'user',
    content: raw.content,
    attachments,
    createdAt: raw.createdAt,
  }
  if (raw.capsule === 'agent2' || raw.capsule === 'agent3' || raw.capsule === 'distill') {
    message.capsule = raw.capsule
  }
  if (typeof raw.compact === 'boolean') {
    message.compact = raw.compact
  }
  const compactText = optionalString(raw.compactText)
  if (compactText) {
    message.compactText = compactText
  }
  return message
}

const parseAssistantMessage = (raw: Record<string, unknown>): AssistantMessage | null => {
  if (
    !isNonEmptyString(raw.id) ||
    typeof raw.content !== 'string' ||
    !isValidTimestamp(raw.createdAt) ||
    !REPLY_STATUSES.includes(raw.status as ReplyStatus)
  ) {
    return null
  }
  const message: AssistantMessage = {
    id: raw.id,
    role: 'assistant',
    content: raw.content,
    status: raw.status as ReplyStatus,
    createdAt: raw.createdAt,
  }
  const reasoning = optionalString(raw.reasoning)
  if (reasoning) {
    message.reasoning = reasoning
  }
  if (isFiniteNumber(raw.reasoningMs)) {
    message.reasoningMs = raw.reasoningMs
  }
  const model = optionalString(raw.model)
  if (model) {
    message.model = model
  }
  if (raw.protocol === 'openai' || raw.protocol === 'anthropic') {
    message.protocol = raw.protocol
  }
  if (raw.slot === 'primary' || raw.slot === 'backup') {
    message.slot = raw.slot
  }
  const channelLabel = optionalString(raw.channelLabel)
  if (channelLabel) {
    message.channelLabel = channelLabel
  }
  const error = parseMessageError(raw.error)
  if (error) {
    message.error = error
  }
  if (isRecord(raw.usage)) {
    const usage: { inputTokens?: number; outputTokens?: number } = {}
    if (isFiniteNumber(raw.usage.inputTokens)) {
      usage.inputTokens = raw.usage.inputTokens
    }
    if (isFiniteNumber(raw.usage.outputTokens)) {
      usage.outputTokens = raw.usage.outputTokens
    }
    message.usage = usage
  }
  if (raw.notice === 'modality-downgraded') {
    message.notice = 'modality-downgraded'
  }
  if (typeof raw.compact === 'boolean') {
    message.compact = raw.compact
  }
  const compactText = optionalString(raw.compactText)
  if (compactText) {
    message.compactText = compactText
  }
  return message
}

const parseSession = (raw: unknown): Session | null => {
  if (!isRecord(raw)) {
    return null
  }
  if (
    !isNonEmptyString(raw.id) ||
    typeof raw.title !== 'string' ||
    !isValidTimestamp(raw.createdAt) ||
    !isValidTimestamp(raw.updatedAt) ||
    !Array.isArray(raw.messages)
  ) {
    return null
  }
  const messages: ChatMessage[] = []
  for (const item of raw.messages) {
    if (!isRecord(item)) {
      return null
    }
    const message =
      item.role === 'user'
        ? parseUserMessage(item)
        : item.role === 'assistant'
          ? parseAssistantMessage(item)
          : null
    if (!message) {
      return null
    }
    messages.push(message)
  }
  return {
    id: raw.id,
    title: raw.title,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    messages,
  }
}

export type ParseJsonBackupResult =
  | { ok: true; sessions: Session[] }
  | { ok: false; error: string; kind?: 'tooLarge' | 'tooMany' }

/** 严格 Schema 校验：任何一条消息不合法都整体拒绝，错误信息只描述结构问题 */
export const parseJsonBackup = (raw: string): ParseJsonBackupResult => {
  // 先看原始字符串长度：至少不会把超大文件先 JSON.parse 进内存；
  // 字符数只是下限，UTF-8 字节数超限也要按文件大小拒绝。
  if (
    raw.length > MAX_JSON_BACKUP_BYTES ||
    new TextEncoder().encode(raw).length > MAX_JSON_BACKUP_BYTES
  ) {
    return {
      ok: false,
      kind: 'tooLarge',
      error: translate('importJsonTooLarge', { size: MAX_JSON_BACKUP_BYTES / (1024 * 1024) }),
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, error: translate('jsonBackupNotJson') }
  }
  if (!isRecord(parsed)) {
    return { ok: false, error: translate('jsonBackupWrongSchema') }
  }
  if (parsed.schema !== JSON_BACKUP_SCHEMA) {
    return { ok: false, error: translate('jsonBackupWrongSchema') }
  }
  if (parsed.version !== 1) {
    return {
      ok: false,
      error: translate('jsonBackupUnsupportedVersion', { version: String(parsed.version) }),
    }
  }
  if (!Array.isArray(parsed.sessions)) {
    return { ok: false, error: translate('jsonBackupNoSessions') }
  }
  if (parsed.sessions.length > MAX_JSON_BACKUP_SESSIONS) {
    return { ok: false, kind: 'tooMany', error: translate('importJsonTooMany') }
  }
  const sessions: Session[] = []
  let messageCount = 0
  for (let index = 0; index < parsed.sessions.length; index++) {
    const session = parseSession(parsed.sessions[index])
    if (!session) {
      return {
        ok: false,
        error: translate('jsonBackupMalformedSession', { index: index + 1 }),
      }
    }
    messageCount += session.messages.length
    if (messageCount > MAX_JSON_BACKUP_MESSAGES) {
      return { ok: false, kind: 'tooMany', error: translate('importJsonTooMany') }
    }
    sessions.push(session)
  }
  return { ok: true, sessions }
}

/** 导入：同 id 已存在时生成新 id，绝不覆盖既有会话；整份备份在单个事务里原子写入 */
export const restoreJsonBackup = async (sessions: Session[]): Promise<AtomicImportResult> =>
  importSessionsAtomically(sessions.map((session) => pickSession(session)))

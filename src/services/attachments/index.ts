/**
 * 纯本地确定性附件解析。
 *
 * 默认 100% 离线：
 * - 源码 / 配置 / 表格 / 工控日志：按 UTF-8(fatal) → GB18030 → windows-1252 回退解码；
 * - .docx / .xlsx / .pptx：fflate 解压 + 原生 DOMParser 提取；
 * - 图片白名单（PNG / JPEG / WebP / GIF）：读为 data URL，供多模态序列化；
 *   SVG 本质是 XML 文本，按纯文本读取；BMP/AVIF/TIFF 等不送内联视觉，明确拒止；
 * - 二进制 PDF / 旧版 .doc/.xls/.ppt / 音频：本地模式明确拒止并提示改用远端解析或粘贴文本，
 *   绝不用粗糙正则硬猜二进制流。
 *
 * 单个附件文本超过 200 KB 时截断保护上下文（前 120 KB + 尾 60 KB）。
 * 拒止结果带上该类型的大小上限 limitMb，界面可以给出准确提示。
 */

import { createId } from '../../utils/id.js'
import type { ChannelSlot } from '../config/types.js'
import type { RemoteContext } from '../api/files.js'
import { uploadRemoteFile } from '../api/files.js'
import { decodeTextBytes, looksBinary } from './decode.js'
import { extractOfficeText, type OfficeExt } from './office.js'
import { truncateExtractedText } from './truncate.js'

export type AttachmentKind = 'text' | 'office' | 'image' | 'remote' | 'rejected'

export type AttachmentError =
  | 'tooLarge'
  | 'unsupported'
  | 'readFailed'
  | 'officeFailed'
  | 'officeTooLarge'
  | 'binaryUnsupported'
  | 'remoteFailed'
  | 'needsRemote'
  | 'imageUnsupported'

export interface Attachment {
  id: string
  name: string
  size: number
  mime: string
  kind: AttachmentKind
  /** 本地提取并截断后的文本（text / office） */
  text?: string
  truncated?: boolean
  originalBytes?: number
  /** 图片 data URL */
  dataUrl?: string
  /** 图片 / 远端文件的媒体类型 */
  mediaType?: string
  /** 远端 Files API 返回的 file_id */
  remoteFileId?: string
  /** 上传文件时的通道槽位；换通道后 file_id 不再可复用 */
  remoteChannel?: ChannelSlot
  /** 上传时的归属指纹：槽位 + 规范化 Files URL + 密钥提示；换槽位 / 端点 / 密钥后失效 */
  remoteEndpoint?: string
  /** 该类型文件的大小上限；拒止时用于准确的界面提示 */
  limitMb?: number
  /** 失败原因码；界面翻译展示 */
  error?: AttachmentError
  errorDetail?: string
}

export const MAX_ATTACHMENTS = 10
export const MAX_LOCAL_FILE_BYTES = 16 * 1024 * 1024
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024
export const MAX_REMOTE_FILE_BYTES = 30 * 1024 * 1024
export const LOCAL_LIMIT_MB = 16
export const IMAGE_LIMIT_MB = 12
export const REMOTE_LIMIT_MB = 30

export const TEXT_EXTENSIONS = new Set([
  'c', 'h', 'cpp', 'hpp', 'cxx', 'cc', 'hh', 'rs', 'py', 'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx',
  'go', 'java', 'kt', 'cs', 'v', 'sv', 'vh', 'svh', 'vhd', 'vhdl', 'm', 'st', 's', 'asm',
  'cmake', 'mk', 'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'xml', 'csv',
  'tsv', 'md', 'markdown', 'txt', 'text', 'log', 'diff', 'patch', 'sh', 'bash', 'bat', 'cmd',
  'ps1', 'sql', 'html', 'htm', 'css', 'scss', 'less', 'env', 'properties', 'gradle', 'pro',
  'ld', 'map', 'hex', 'srec', 'svg', 'rst', 'tex', 'dockerfile', 'gitignore', 'editorconfig',
])

/** 仅这四种图片格式送内联视觉；其余 image/* 明确拒止而不是静默降级 */
const INLINE_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif'])
const INLINE_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const OTHER_IMAGE_EXTENSIONS = new Set([
  'bmp', 'avif', 'tif', 'tiff', 'ico', 'heic', 'heif', 'heics', 'psd', 'raw', 'cr2', 'nef', 'dng',
])

const OFFICE_EXTENSIONS: Record<string, OfficeExt> = {
  docx: 'docx',
  xlsx: 'xlsx',
  pptx: 'pptx',
}

/** 官方 document 内容块真正支持的远端类型：只有 PDF */
const REMOTE_DOCUMENT_EXTENSIONS = new Set(['pdf'])
/** 旧版二进制文档与音频：即使开启远端解析也确定性拒止，避免静默丢掉公式与版式 */
const LEGACY_BINARY_EXTENSIONS = new Set(['doc', 'xls', 'ppt'])
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac', 'wma', 'opus', 'amr'])

const MIME_GUESS: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  pdf: 'application/pdf',
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

export const getFileExt = (name: string): string => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export const resolveMime = (file: File): string =>
  file.type || MIME_GUESS[getFileExt(file.name)] || 'application/octet-stream'

export const formatSize = (bytes: number): string => {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

const readBytes = async (file: File): Promise<Uint8Array> =>
  new Uint8Array(await file.arrayBuffer())

const readDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(file)
  })

/**
 * 文件系统给出的 MIME 可能是 application/octet-stream，而魔数 / 扩展名已确认是合法图片。
 * Data URL 头部必须同步成真实图片 MIME，否则 Anthropic 序列化会发出错误的 media_type。
 */
const rewriteDataUrlMime = (dataUrl: string, mime: string): string => {
  const comma = dataUrl.indexOf(',')
  if (!dataUrl.startsWith('data:') || comma < 0) {
    return dataUrl
  }
  return `data:${mime};base64,${dataUrl.slice(comma + 1)}`
}

/**
 * 文件头魔数嗅探：文件系统既没给 MIME 也没有扩展名时，仍要能识别合法图片。
 * 只认四种允许内联视觉的格式，命中后按正常图片流程读取并修正 Data URL MIME。
 */
const sniffImageMime = (head: Uint8Array): string | null => {
  const startsWith = (signature: readonly number[], offset = 0): boolean =>
    signature.every((byte, index) => head[offset + index] === byte)
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png'
  }
  if (startsWith([0xff, 0xd8, 0xff])) {
    return 'image/jpeg'
  }
  if (startsWith([0x47, 0x49, 0x46, 0x38])) {
    return 'image/gif'
  }
  // RIFF....WEBP：前 4 字节 RIFF，第 8..11 字节 WEBP
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) {
    return 'image/webp'
  }
  return null
}

const rejected = (
  file: File,
  mime: string,
  error: AttachmentError,
  options: { limitMb?: number; errorDetail?: string } = {}
): Attachment => ({
  id: createId(),
  name: file.name || 'attachment',
  size: file.size,
  mime,
  kind: 'rejected',
  error,
  errorDetail: options.errorDetail,
  limitMb: options.limitMb,
})

const localTextAttachment = (file: File, mime: string, rawText: string): Attachment => {
  const truncated = truncateExtractedText(rawText)
  return {
    id: createId(),
    name: file.name || 'attachment',
    size: file.size,
    mime,
    kind: 'text',
    text: truncated.text,
    truncated: truncated.truncated,
    originalBytes: truncated.originalBytes,
  }
}

/** DOMParser 仅在浏览器环境可用；没有时 Office 解析直接判失败而不是猜测 */
const officeParserAvailable = (): boolean => typeof DOMParser !== 'undefined'

const isSvgFile = (ext: string, mime: string): boolean =>
  ext === 'svg' || mime.toLowerCase() === 'image/svg+xml'

const isInlineImage = (ext: string, mime: string): boolean =>
  INLINE_IMAGE_EXTENSIONS.has(ext) || INLINE_IMAGE_MIME_TYPES.has(mime.toLowerCase())

const looksLikeOtherImage = (ext: string, mime: string): boolean =>
  OTHER_IMAGE_EXTENSIONS.has(ext) || mime.toLowerCase().startsWith('image/')

export interface ParseOptions {
  /** 通道允许且已开启远端文件接口时才传入 */
  remote: RemoteContext | null
}

export const parseAttachmentFile = async (
  file: File,
  options: ParseOptions
): Promise<Attachment> => {
  const ext = getFileExt(file.name)
  let mime = resolveMime(file)

  // 没有 MIME 也没有扩展名时按魔数识别图片：识别命中就等价于“扩展名确认是图片”，
  // 读出的 Data URL 头部也必须同步成真实图片 MIME。
  if ((!file.type || file.type === 'application/octet-stream') && !ext) {
    try {
      const head = new Uint8Array(await file.slice(0, 12).arrayBuffer())
      const sniffed = sniffImageMime(head)
      if (sniffed) {
        mime = sniffed
      }
    } catch {
      // 读不到文件头时保持原判定，后续按文本 / 拒止路径处理
    }
  }

  // SVG 作为 XML 文本读取：既避免把脚本当图片送进视觉模型，也保留可检索的矢量源码
  if (isSvgFile(ext, mime)) {
    if (file.size > MAX_LOCAL_FILE_BYTES) {
      return rejected(file, mime, 'tooLarge', { limitMb: LOCAL_LIMIT_MB })
    }
    try {
      const bytes = await readBytes(file)
      return localTextAttachment(file, mime, decodeTextBytes(bytes).text)
    } catch {
      return rejected(file, mime, 'readFailed', { limitMb: LOCAL_LIMIT_MB })
    }
  }

  if (officeParserAvailable() && OFFICE_EXTENSIONS[ext]) {
    if (file.size > MAX_LOCAL_FILE_BYTES) {
      return rejected(file, mime, 'tooLarge', { limitMb: LOCAL_LIMIT_MB })
    }
    try {
      const bytes = await readBytes(file)
      const result = extractOfficeText(OFFICE_EXTENSIONS[ext], bytes, new DOMParser())
      if (!result.ok) {
        return rejected(
          file,
          mime,
          result.error === 'officeTooLarge' ? 'officeTooLarge' : 'officeFailed',
          { limitMb: LOCAL_LIMIT_MB }
        )
      }
      if (!result.text) {
        return rejected(file, mime, 'officeFailed', { limitMb: LOCAL_LIMIT_MB })
      }
      const truncated = truncateExtractedText(result.text)
      return {
        id: createId(),
        name: file.name || 'document',
        size: file.size,
        mime,
        kind: 'office',
        text: truncated.text,
        // 整份文档的 256 KB 字节预算可能在单个 200 KB 文本截断之前就已触底
        truncated: truncated.truncated || result.truncated === true,
        originalBytes: truncated.originalBytes,
      }
    } catch {
      return rejected(file, mime, 'readFailed', { limitMb: LOCAL_LIMIT_MB })
    }
  }

  if (isInlineImage(ext, mime)) {
    if (file.size > MAX_IMAGE_BYTES) {
      return rejected(file, mime, 'tooLarge', { limitMb: IMAGE_LIMIT_MB })
    }
    try {
      const mediaType = INLINE_IMAGE_MIME_TYPES.has(mime.toLowerCase())
        ? mime.toLowerCase()
        : (MIME_GUESS[ext] ?? 'image/png')
      const dataUrl = rewriteDataUrlMime(await readDataUrl(file), mediaType)
      return {
        id: createId(),
        name: file.name || 'image',
        size: file.size,
        mime: mediaType,
        kind: 'image',
        dataUrl,
        mediaType,
      }
    } catch {
      return rejected(file, mime, 'readFailed', { limitMb: IMAGE_LIMIT_MB })
    }
  }

  if (looksLikeOtherImage(ext, mime)) {
    return rejected(file, mime, 'imageUnsupported', { limitMb: IMAGE_LIMIT_MB })
  }

  // 旧版二进制 Office 与音频：官方 document 块不支持，开启远端接口也不放行
  if (LEGACY_BINARY_EXTENSIONS.has(ext) || AUDIO_EXTENSIONS.has(ext)) {
    return rejected(file, mime, 'binaryUnsupported', { limitMb: REMOTE_LIMIT_MB })
  }

  if (REMOTE_DOCUMENT_EXTENSIONS.has(ext)) {
    if (file.size > MAX_REMOTE_FILE_BYTES) {
      return rejected(file, mime, 'tooLarge', { limitMb: REMOTE_LIMIT_MB })
    }
    if (options.remote) {
      const uploaded = await uploadRemoteFile(options.remote, file)
      if (!uploaded.ok) {
        return rejected(file, mime, 'remoteFailed', {
          limitMb: REMOTE_LIMIT_MB,
          errorDetail: uploaded.detail,
        })
      }
      return {
        id: createId(),
        name: file.name || 'document',
        size: file.size,
        mime,
        kind: 'remote',
        remoteFileId: uploaded.fileId,
        remoteChannel: options.remote.slot,
        // 指纹由上传入口在配置同步之后用最新端点与实际生效凭据计算，
        // 保证刚切换端点就上传的附件归属同步后的槽位，而不是防抖窗口里的旧快照
        remoteEndpoint: uploaded.fingerprint,
        limitMb: REMOTE_LIMIT_MB,
        mediaType: mime,
      }
    }
    return rejected(file, mime, 'binaryUnsupported', { limitMb: REMOTE_LIMIT_MB })
  }

  if (file.size > MAX_LOCAL_FILE_BYTES) {
    return rejected(file, mime, 'tooLarge', { limitMb: LOCAL_LIMIT_MB })
  }

  try {
    const bytes = await readBytes(file)
    const textLike = TEXT_EXTENSIONS.has(ext) || mime.startsWith('text/') || mime.includes('json')
    if (!textLike && looksBinary(bytes)) {
      return rejected(file, mime, 'unsupported', { limitMb: LOCAL_LIMIT_MB })
    }
    const decoded = decodeTextBytes(bytes)
    if (!textLike && looksBinary(new TextEncoder().encode(decoded.text))) {
      return rejected(file, mime, 'unsupported', { limitMb: LOCAL_LIMIT_MB })
    }
    return localTextAttachment(file, mime, decoded.text)
  } catch {
    return rejected(file, mime, 'readFailed', { limitMb: LOCAL_LIMIT_MB })
  }
}

/**
 * 附件文本拼进用户消息的包裹格式。
 * 外部文本里的字面闭合标签必须转义，否则附件内容可以提前闭合上下文块。
 */
export const wrapAttachmentText = (name: string, text: string): string =>
  `<attached_file name="${name.replace(/"/g, "'")}">\n${text.replace(
    /<\/attached_file/gi,
    '&lt;/attached_file'
  )}\n</attached_file>`

export const buildAttachmentPrompt = (attachments: Attachment[]): string =>
  attachments
    .filter((attachment) => attachment.text)
    .map((attachment) => wrapAttachmentText(attachment.name, attachment.text ?? ''))
    .join('\n\n')

export const collectImageInputs = (attachments: Attachment[]) =>
  attachments
    .filter((attachment) => attachment.kind === 'image' && attachment.dataUrl)
    .map((attachment) => ({
      name: attachment.name,
      mediaType: attachment.mediaType ?? attachment.mime,
      dataUrl: attachment.dataUrl ?? '',
    }))

export const collectRemoteFiles = (attachments: Attachment[]) =>
  attachments
    .filter((attachment) => attachment.kind === 'remote' && attachment.remoteFileId)
    .map((attachment) => ({
      fileId: attachment.remoteFileId ?? '',
      name: attachment.name,
      mediaType: attachment.mediaType ?? attachment.mime,
      endpoint: attachment.remoteEndpoint,
    }))

/** 是否为不可送入请求的失败附件 */
export const isRejectedAttachment = (attachment: Attachment): boolean =>
  attachment.kind === 'rejected'

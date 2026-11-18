/**
 * 超大文本防爆截断：单附件超过 200 KB 时保留前 120 KB + 尾 60 KB，
 * 并插入清晰的截断说明；附件卡片同步标注"已截断保护上下文"。
 */

export const MAX_EXTRACTED_BYTES = 200 * 1024
export const HEAD_BYTES = 120 * 1024
export const TAIL_BYTES = 60 * 1024

const encoder = new TextEncoder()

const takePrefixByBytes = (text: string, limit: number): string => {
  let bytes = 0
  let index = 0
  for (const char of text) {
    const size = encoder.encode(char).length
    if (bytes + size > limit) {
      break
    }
    bytes += size
    index += char.length
  }
  return text.slice(0, index)
}

const takeSuffixByBytes = (text: string, limit: number): string => {
  const chars = Array.from(text)
  let bytes = 0
  let taken = 0
  for (let i = chars.length - 1; i >= 0; i--) {
    const size = encoder.encode(chars[i]).length
    if (bytes + size > limit) {
      break
    }
    bytes += size
    taken++
  }
  return chars.slice(chars.length - taken).join('')
}

export interface TruncatedText {
  text: string
  truncated: boolean
  originalBytes: number
}

export const truncateExtractedText = (
  text: string,
  maxBytes = MAX_EXTRACTED_BYTES
): TruncatedText => {
  const originalBytes = encoder.encode(text).length
  if (originalBytes <= maxBytes) {
    return { text, truncated: false, originalBytes }
  }
  const head = takePrefixByBytes(text, HEAD_BYTES)
  const tail = takeSuffixByBytes(text, TAIL_BYTES)
  const marker = `\n\n[Attachment text truncated: original ${originalBytes} bytes; kept first 120 KB and last 60 KB]\n\n`
  return { text: head + marker + tail, truncated: true, originalBytes }
}

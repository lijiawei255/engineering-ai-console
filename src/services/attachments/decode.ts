/**
 * 本地文本解码：UTF-8 (fatal) → GB18030 → windows-1252 逐级回退。
 * 传统嵌入式工具链（Keil / IAR / 串口日志）导出的 GBK/GB18030 中文日志零乱码。
 */

export type DecodeEncoding = 'utf-8' | 'gb18030' | 'windows-1252'

const decodeWith = (bytes: Uint8Array, encoding: string, fatal: boolean): string | null => {
  try {
    return new TextDecoder(encoding, { fatal }).decode(bytes)
  } catch {
    return null
  }
}

export interface DecodedText {
  text: string
  encoding: DecodeEncoding
}

export const decodeTextBytes = (bytes: Uint8Array): DecodedText => {
  const utf8 = decodeWith(bytes, 'utf-8', true)
  if (utf8 !== null) {
    return { text: utf8, encoding: 'utf-8' }
  }
  const gb18030 = decodeWith(bytes, 'gb18030', true)
  if (gb18030 !== null) {
    return { text: gb18030, encoding: 'gb18030' }
  }
  const fallback = decodeWith(bytes, 'windows-1252', false)
  return { text: fallback ?? '', encoding: 'windows-1252' }
}

/** 粗略二进制判定：出现 NUL 或控制字符比例过高时不当作文本解析 */
export const looksBinary = (bytes: Uint8Array): boolean => {
  const sample = bytes.subarray(0, Math.min(bytes.length, 8192))
  let control = 0
  for (const byte of sample) {
    if (byte === 0) {
      return true
    }
    const isControl = byte < 32 && byte !== 9 && byte !== 10 && byte !== 13 && byte !== 12
    if (isControl) {
      control++
    }
  }
  return sample.length > 0 && control / sample.length > 0.05
}

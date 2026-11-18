import type { ChannelConfig } from '../config/types.js'

/** 纯静态直连模式下的请求头：密钥只用本地保存的 apiKey，环境变量名在浏览器中不可读 */
export const directRequestHeaders = (channel: ChannelConfig): Record<string, string> => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  }
  const apiKey = channel.apiKey.trim()
  if (channel.protocol === 'openai') {
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`
    }
  } else {
    headers['anthropic-version'] = '2023-06-01'
    if (apiKey) {
      headers['x-api-key'] = apiKey
    }
    if (channel.enableRemoteFileApi) {
      headers['anthropic-beta'] = 'files-api-2025-04-14'
    }
  }
  for (const header of channel.customHeaders) {
    headers[header.name] = header.value
  }
  return headers
}

/** 纯静态直连模式下探测模型列表用的请求头 */
export const directProbeHeaders = (channel: ChannelConfig): Record<string, string> => {
  const apiKey = channel.apiKey.trim()
  const headers: Record<string, string> = {}
  if (channel.protocol === 'openai') {
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`
    }
  } else {
    headers['anthropic-version'] = '2023-06-01'
    if (apiKey) {
      headers['x-api-key'] = apiKey
    }
  }
  for (const header of channel.customHeaders) {
    headers[header.name] = header.value
  }
  return headers
}

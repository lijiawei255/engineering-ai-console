/**
 * 渠道地址归一化。
 *
 * 用户可能填写主机根地址、/v1 前缀或完整的 /chat/completions、/messages 端点，
 * 这里统一清洗为实际请求 URL，并把结果显示在设置界面。特殊企业网关可开启
 * lockRawUrl 完全跳过拼接（此时地址必须本身就是完整端点）。
 */

import type { Protocol } from '../config/types.js'

export type UrlError =
  | 'emptyUrl'
  | 'invalidUrl'
  | 'invalidProtocol'
  | 'baseUrlHasQuery'

export type UrlResult = { ok: true; url: string } | { ok: false; error: UrlError }

export interface UrlInput {
  protocol: Protocol
  baseUrl: string
  lockRawUrl: boolean
}

const stripTrailingSlashes = (value: string) => value.replace(/\/+$/, '')

/** 基础校验：非空、http/https、非锁定模式下不允许查询串或片段混在基础地址里 */
const validate = (input: UrlInput): UrlResult => {
  const raw = input.baseUrl.trim()
  if (!raw) {
    return { ok: false, error: 'emptyUrl' }
  }
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return { ok: false, error: 'invalidUrl' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'invalidProtocol' }
  }
  if (!input.lockRawUrl && (parsed.search || parsed.hash)) {
    return { ok: false, error: 'baseUrlHasQuery' }
  }
  return { ok: true, url: raw }
}

const joinModelsUrl = (protocol: Protocol, url: string): string => {
  const trimmed = stripTrailingSlashes(url)
  if (protocol === 'openai') {
    if (/\/chat\/completions$/i.test(trimmed)) {
      return trimmed.replace(/\/chat\/completions$/i, '/models')
    }
    if (/\/v1$/i.test(trimmed)) {
      return `${trimmed}/models`
    }
    return `${trimmed}/v1/models`
  }
  if (/\/messages$/i.test(trimmed)) {
    return trimmed.replace(/\/messages$/i, '/models')
  }
  if (/\/v1$/i.test(trimmed)) {
    return `${trimmed}/models`
  }
  if (/\/anthropic$/i.test(trimmed)) {
    return `${trimmed}/v1/models`
  }
  return `${trimmed}/v1/models`
}

const joinOpenAiChatUrl = (url: string): string => {
  const trimmed = stripTrailingSlashes(url)
  if (/\/chat\/completions$/i.test(trimmed)) {
    return trimmed
  }
  if (/\/v1$/i.test(trimmed)) {
    return `${trimmed}/chat/completions`
  }
  return `${trimmed}/v1/chat/completions`
}

const joinAnthropicChatUrl = (url: string): string => {
  const trimmed = stripTrailingSlashes(url)
  if (/\/messages$/i.test(trimmed)) {
    return trimmed
  }
  if (/\/v1$/i.test(trimmed)) {
    return `${trimmed}/messages`
  }
  if (/\/anthropic$/i.test(trimmed)) {
    return `${trimmed}/v1/messages`
  }
  return `${trimmed}/v1/messages`
}

/** 实际聊天请求 URL */
export const normalizeChatUrl = (input: UrlInput): UrlResult => {
  const validated = validate(input)
  if (!validated.ok) {
    return validated
  }
  if (input.lockRawUrl) {
    return validated
  }
  const base = validated.url
  return {
    ok: true,
    url: input.protocol === 'openai' ? joinOpenAiChatUrl(base) : joinAnthropicChatUrl(base),
  }
}

/** 模型列表探测 URL；锁定原始地址时直接探测该地址 */
export const normalizeModelsUrl = (input: UrlInput): UrlResult => {
  const validated = validate(input)
  if (!validated.ok) {
    return validated
  }
  if (input.lockRawUrl) {
    return validated
  }
  return { ok: true, url: joinModelsUrl(input.protocol, validated.url) }
}

/** 上传文件接口（Anthropic Files Beta）：{base}/v1/files */
export const normalizeFilesUrl = (input: UrlInput): UrlResult => {
  const validated = validate(input)
  if (!validated.ok) {
    return validated
  }
  const trimmed = stripTrailingSlashes(validated.url)
  // 用户直接填了完整 /messages 端点时，Files API 与它同前缀：把末段换成 /files，
  // 不能简单追加，否则会拼出 .../v1/messages/v1/files。
  if (/\/messages$/i.test(trimmed)) {
    return { ok: true, url: trimmed.replace(/\/messages$/i, '/files') }
  }
  if (/\/anthropic\/v1$/i.test(trimmed)) {
    return { ok: true, url: `${trimmed}/files` }
  }
  if (/\/v1$/i.test(trimmed)) {
    return { ok: true, url: `${trimmed}/files` }
  }
  if (/\/anthropic$/i.test(trimmed)) {
    return { ok: true, url: `${trimmed}/v1/files` }
  }
  return { ok: true, url: `${trimmed}/v1/files` }
}

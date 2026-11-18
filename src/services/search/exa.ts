/**
 * Exa 检索客户端（webSearchMode === 'exa' 时使用）。
 *
 * 服务端模式由本地服务读取 Exa 密钥并请求检索端点；纯静态模式带本机密钥直连。
 * 结果只取标题、链接与摘要，拼入本轮用户消息上下文，兼容任意聊天模型。
 */

import type { AppSettings, ChannelConfig } from '../config/types.js'
import { getServerToken, useConfigStore } from '../config/store.js'
import { translate } from '../../i18n/index.js'
import {
  escapeWebSearchContextTag,
  WEB_SEARCH_CONTEXT_CLOSE,
  WEB_SEARCH_CONTEXT_TAG,
} from './contextTags.js'

export interface ExaResult {
  title: string
  url: string
  snippet: string
}

export type ExaResponse =
  | { ok: true; results: ExaResult[] }
  | { ok: false; error: 'network' | 'http' | 'config'; detail: string }

export interface ExaSearchOptions {
  query: string
  channel: ChannelConfig
  /** 用户中止本轮回复时一并取消检索请求 */
  signal?: AbortSignal
}

const numResultsOf = (settings: AppSettings): number =>
  Math.min(10, Math.max(1, settings.exa.numResults))

const resultFromItem = (item: unknown): ExaResult | null => {
  if (typeof item !== 'object' || item === null) {
    return null
  }
  const record = item as Record<string, unknown>
  const url = typeof record.url === 'string' ? record.url : ''
  if (!url) {
    return null
  }
  const title = typeof record.title === 'string' && record.title.trim() ? record.title : url
  const snippetSource = record.text ?? record.snippet ?? record.summary ?? record.highlights
  let snippet = ''
  if (typeof snippetSource === 'string') {
    snippet = snippetSource
  } else if (Array.isArray(snippetSource)) {
    snippet = snippetSource.filter((value) => typeof value === 'string').join(' ')
  }
  return { title, url, snippet: snippet.replace(/\s+/g, ' ').trim().slice(0, 600) }
}

const parseResults = (payload: unknown): ExaResult[] => {
  if (typeof payload !== 'object' || payload === null) {
    return []
  }
  const results = (payload as Record<string, unknown>).results
  if (!Array.isArray(results)) {
    return []
  }
  return results
    .map(resultFromItem)
    .filter((result): result is ExaResult => result !== null)
    .slice(0, 10)
}

const validEndpoint = (endpoint: string): string | null => {
  try {
    const url = new URL(endpoint)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

export const searchExa = async (options: ExaSearchOptions): Promise<ExaResponse> => {
  const state = useConfigStore.getState()
  const settings = state.settings
  const numResults = numResultsOf(settings)
  if (options.signal?.aborted) {
    return { ok: false, error: 'network', detail: 'aborted' }
  }
  if (state.mode === 'server') {
    try {
      const response = await fetch('/api/search/exa', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Console-Token': getServerToken(),
        },
        body: JSON.stringify({ query: options.query, numResults }),
        signal: options.signal,
        cache: 'no-store',
      })
      const text = await response.text()
      if (!response.ok) {
        return { ok: false, error: 'http', detail: text.slice(0, 300) }
      }
      let payload: unknown
      try {
        payload = JSON.parse(text)
      } catch {
        return { ok: false, error: 'http', detail: translate('errorInvalidJson') }
      }
      return { ok: true, results: parseResults(payload) }
    } catch (error) {
      return {
        ok: false,
        error: 'network',
        detail: error instanceof Error ? error.message : String(error),
      }
    }
  }

  const endpoint = validEndpoint(settings.exa.endpoint)
  if (!endpoint) {
    return { ok: false, error: 'config', detail: translate('errorInvalidExaEndpoint') }
  }
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (settings.exa.apiKey.trim()) {
      headers['x-api-key'] = settings.exa.apiKey.trim()
    }
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query: options.query,
        numResults,
        contents: { text: { maxCharacters: 600 } },
      }),
      signal: options.signal,
      cache: 'no-store',
    })
    const text = await response.text()
    if (!response.ok) {
      return { ok: false, error: 'http', detail: text.slice(0, 300) }
    }
    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      return { ok: false, error: 'http', detail: translate('errorInvalidJson') }
    }
    return { ok: true, results: parseResults(payload) }
  } catch (error) {
    return {
      ok: false,
      error: 'network',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * 检索文本会作为不可信外部数据拼进提示词：用户 query 与结果里出现的字面标签
 * 必须转义，避免提前闭合或伪造 <web_search_context> 上下文块。
 */
const escapeResultClosingTag = (value: string): string => escapeWebSearchContextTag(value)

/** 拼入本轮用户消息的检索上下文块 */
export const formatExaContext = (query: string, results: ExaResult[]): string => {
  const lines = results.map(
    (result, index) =>
      `[${index + 1}] ${escapeResultClosingTag(result.title)}\nURL: ${escapeResultClosingTag(result.url)}\n${escapeResultClosingTag(result.snippet)}`
  )
  return [
    `<${WEB_SEARCH_CONTEXT_TAG} query="${escapeResultClosingTag(query.replace(/"/g, "'").slice(0, 300))}">`,
    ...lines,
    WEB_SEARCH_CONTEXT_CLOSE,
    'Use the search results above only when they are relevant; state clearly when they do not answer the question.',
  ].join('\n')
}

/**
 * 模型列表探测与连通性自检。
 *
 * 服务端模式由本地服务校验并请求（可携带设置弹窗中尚未保存的草稿参数）；
 * 纯静态模式带本机密钥直连。模型列表不可用时平滑返回空列表，绝不阻断手动输入。
 */

import type { ChannelConfig, ChannelSlot } from '../config/types.js'
import { getServerToken, useConfigStore } from '../config/store.js'
import { translate, type TranslationKey } from '../../i18n/index.js'
import { directProbeHeaders } from './headers.js'
import { normalizeModelsUrl, type UrlError } from './url.js'

const URL_ERROR_KEYS: Record<UrlError, TranslationKey> = {
  emptyUrl: 'urlErrorEmpty',
  invalidUrl: 'urlErrorInvalid',
  invalidProtocol: 'urlErrorProtocol',
  baseUrlHasQuery: 'urlErrorQuery',
}

export interface ProbeContext {
  slot: ChannelSlot
  channel: ChannelConfig
  /** 设置弹窗中尚未保存的草稿密钥（仅用于本次探测，不落盘） */
  draftKey?: string
}

export interface ModelsProbeResult {
  reachable: boolean
  models: string[]
  message?: string
}

export interface PingResult {
  reachable: boolean
  modelsAvailable: boolean
  message?: string
}

const parseModelList = (payload: unknown): string[] => {
  const ids: string[] = []
  const pushId = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) {
      ids.push(value.trim())
    }
  }
  if (Array.isArray(payload)) {
    for (const item of payload) {
      if (typeof item === 'string') {
        pushId(item)
      } else if (typeof item === 'object' && item !== null) {
        pushId((item as Record<string, unknown>).id)
        pushId((item as Record<string, unknown>).name)
      }
    }
    return ids
  }
  if (typeof payload === 'object' && payload !== null) {
    const record = payload as Record<string, unknown>
    const data = record.data ?? record.models
    if (Array.isArray(data)) {
      for (const item of data) {
        if (typeof item === 'string') {
          pushId(item)
        } else if (typeof item === 'object' && item !== null) {
          pushId((item as Record<string, unknown>).id)
          pushId((item as Record<string, unknown>).name)
        }
      }
    }
  }
  return Array.from(new Set(ids))
}

const serverPost = async (path: string, body: unknown): Promise<Response> =>
  fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Console-Token': getServerToken(),
    },
    body: JSON.stringify(body),
    cache: 'no-store',
  })

const staticProbe = async (context: ProbeContext): Promise<ModelsProbeResult> => {
  const url = normalizeModelsUrl(context.channel)
  if (!url.ok) {
    return { reachable: false, models: [], message: translate(URL_ERROR_KEYS[url.error]) }
  }
  const headers = directProbeHeaders(context.channel)
  if (context.draftKey) {
    if (context.channel.protocol === 'openai') {
      headers.Authorization = `Bearer ${context.draftKey}`
    } else {
      headers['x-api-key'] = context.draftKey
    }
  }
  try {
    const response = await fetch(url.url, { method: 'GET', headers, cache: 'no-store' })
    if (!response.ok) {
      return {
        reachable: response.status !== 404,
        models: [],
        message: `HTTP ${response.status}`,
      }
    }
    const text = await response.text()
    try {
      return { reachable: true, models: parseModelList(JSON.parse(text)) }
    } catch {
      return { reachable: true, models: [], message: translate('errorInvalidJson') }
    }
  } catch (error) {
    return {
      reachable: false,
      models: [],
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

export const probeModels = async (context: ProbeContext): Promise<ModelsProbeResult> => {
  if (useConfigStore.getState().mode === 'static') {
    return staticProbe(context)
  }
  try {
    const response = await serverPost('/api/models', {
      slot: context.slot,
      draft: context.channel,
      draftKey: context.draftKey,
    })
    const text = await response.text()
    if (!response.ok) {
      return { reachable: false, models: [], message: text.slice(0, 300) }
    }
    const payload = JSON.parse(text) as ModelsProbeResult
    return {
      reachable: payload.reachable === true,
      models: Array.isArray(payload.models) ? payload.models.filter((id) => typeof id === 'string') : [],
      message: typeof payload.message === 'string' ? payload.message : undefined,
    }
  } catch (error) {
    return {
      reachable: false,
      models: [],
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

export const pingChannel = async (context: ProbeContext): Promise<PingResult> => {
  if (useConfigStore.getState().mode === 'static') {
    const result = await staticProbe(context)
    return {
      reachable: result.reachable,
      modelsAvailable: result.models.length > 0,
      message: result.message,
    }
  }
  try {
    const response = await serverPost('/api/ping', {
      slot: context.slot,
      draft: context.channel,
      draftKey: context.draftKey,
    })
    const text = await response.text()
    if (!response.ok) {
      return { reachable: false, modelsAvailable: false, message: text.slice(0, 300) }
    }
    const payload = JSON.parse(text) as PingResult
    return {
      reachable: payload.reachable === true,
      modelsAvailable: payload.modelsAvailable === true,
      message: typeof payload.message === 'string' ? payload.message : undefined,
    }
  } catch (error) {
    return {
      reachable: false,
      modelsAvailable: false,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

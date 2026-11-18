/**
 * 远端文件接口客户端（Anthropic Files Beta）。
 *
 * 只有通道显式开启远端文档解析（配置字段 enableRemoteFileApi）时才会走到这里；
 * 服务端模式下转发到本地服务，纯静态模式下带本机密钥直连。默认纯本地模式完全不触碰该接口。
 *
 * 所有请求都依赖“服务端已存槽位配置”：用户刚改完端点 / 协议 / 密钥时，前端 350 ms
 * 防抖队列里可能还有未落盘的编辑，服务端读到的仍是旧配置。因此上传与删除在发请求前
 * 必须先 await ensureConfigSynced()，并用同步后的最新配置重新计算归属指纹。
 */

import type { ChannelConfig, ChannelSlot } from '../config/types.js'
import {
  ensureConfigSynced,
  remoteKeyFingerprintOf,
  useConfigStore,
} from '../config/store.js'
import { translate } from '../../i18n/index.js'
import { normalizeFilesUrl } from './url.js'

export type RemoteFileResult =
  | { ok: true; fileId: string; fingerprint: string }
  | { ok: false; error: 'config' | 'network' | 'http'; detail: string }

export interface RemoteContext {
  mode: 'server' | 'static'
  token: string
  slot: ChannelSlot
  channel: ChannelConfig
  /** 当前通道实际生效凭据的短指纹（服务端 sha256[:12] / 静态模式等效计算） */
  keyFingerprint?: string
}

/**
 * 远端 file_id 的归属指纹：槽位 + 规范化 Files URL + 实际生效凭据指纹。
 *
 * 同一个网关换到另一把真正生效的 Key 或另一个槽位后，旧 file_id 属于另一个凭据
 * 空间，继续混发会被上游拒绝或（更糟）读到别的账号的文件，因此必须让指纹失效。
 * 只有“填了但没生效”的环境变量名不会参与指纹：它不决定真正发出去的凭据。
 */
export const remoteFileFingerprint = (
  slot: ChannelSlot,
  channel: ChannelConfig,
  keyFingerprint = 'none'
): string => {
  const filesUrl = normalizeFilesUrl(channel)
  const endpoint = filesUrl.ok ? filesUrl.url : ''
  return [slot, endpoint, keyFingerprint.trim() || 'none'].join('|')
}

/**
 * 删除远端文件前的归属复核：附件记录的指纹必须仍与当前槽位的规范化端点 + 实际生效
 * 凭据指纹一致。用户在上传后改了该槽位的端点或密钥时，旧 file_id 已属于另一个凭据
 * 空间，只能从本地草稿移除，绝不能再向新端点发 DELETE。
 */
export const remoteFileOriginMatches = (
  context: RemoteContext,
  origin: string | undefined
): boolean =>
  Boolean(origin) &&
  remoteFileFingerprint(context.slot, context.channel, context.keyFingerprint ?? '') === origin

/**
 * 取同步后的最新上下文：地址、协议、密钥掩码与归属指纹都以落盘后的配置为准，
 * 调用方在防抖窗口内捕获的旧快照不参与真正发出的请求与指纹计算。
 */
const latestContextOf = (context: RemoteContext): RemoteContext => {
  const state = useConfigStore.getState()
  return {
    mode: context.mode,
    token: state.serverToken || context.token,
    slot: context.slot,
    channel: state.settings.channels[context.slot],
    keyFingerprint: remoteKeyFingerprintOf(context.slot),
  }
}

const FILE_PURPOSE = (name: string): string => {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return ['pdf', 'doc', 'docx', 'ppt', 'pptx'].includes(ext)
    ? 'rich_layout_recognition'
    : 'user_data'
}

const FILES_BETA = 'files-api-2025-04-14'

export const uploadRemoteFile = async (
  context: RemoteContext,
  file: File
): Promise<RemoteFileResult> => {
  // 切换端点 / 协议 / 密钥后立即上传时，先把防抖队列里的最新配置真正写进 server.py；
  // 否则服务端会按旧槽位地址转发，文件被传到错误的网关。
  try {
    await ensureConfigSynced()
  } catch (error) {
    return {
      ok: false,
      error: 'config',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
  const latest = latestContextOf(context)
  const fingerprint = remoteFileFingerprint(
    latest.slot,
    latest.channel,
    latest.keyFingerprint ?? ''
  )
  const form = new FormData()
  form.append('purpose', FILE_PURPOSE(file.name))
  form.append('file', file, file.name)
  try {
    let response: Response
    if (latest.mode === 'server') {
      response = await fetch('/api/files/upload', {
        method: 'POST',
        headers: {
          'X-Console-Token': latest.token,
          'X-Console-Slot': latest.slot,
        },
        body: form,
        cache: 'no-store',
      })
    } else {
      const url = normalizeFilesUrl(latest.channel)
      if (!url.ok) {
        return { ok: false, error: 'config', detail: translate('urlErrorInvalid') }
      }
      const headers: Record<string, string> = {
        'anthropic-version': '2023-06-01',
        'anthropic-beta': FILES_BETA,
      }
      const apiKey = latest.channel.apiKey.trim()
      if (apiKey) {
        headers['x-api-key'] = apiKey
      }
      for (const header of latest.channel.customHeaders) {
        headers[header.name] = header.value
      }
      response = await fetch(url.url, { method: 'POST', headers, body: form, cache: 'no-store' })
    }
    const text = await response.text()
    if (!response.ok) {
      return { ok: false, error: 'http', detail: text.slice(0, 300) || `HTTP ${response.status}` }
    }
    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      return { ok: false, error: 'http', detail: translate('errorInvalidJson') }
    }
    const id =
      typeof payload === 'object' && payload !== null
        ? (payload as Record<string, unknown>).id
        : undefined
    return typeof id === 'string' && id
      ? { ok: true, fileId: id, fingerprint }
      : { ok: false, error: 'http', detail: translate('errorFileIdMissing') }
  } catch (error) {
    return {
      ok: false,
      error: 'network',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * 删除远端文件；失败时静默忽略，不阻塞本地流程。使用上传时的原槽位与自定义请求头。
 *
 * origin 是上传时记录的归属指纹。发请求前先同步配置，再用同步后的槽位端点与实际
 * 生效凭据复核归属；远端开关已关闭或归属不再匹配时只做本地移除，绝不产生出站请求。
 */
export const deleteRemoteFile = async (
  context: RemoteContext,
  origin: string | undefined,
  fileId: string
): Promise<void> => {
  try {
    await ensureConfigSynced()
  } catch {
    // 配置无法落盘时不能猜测端点：宁可不清理远端文件，也不向错误网关发 DELETE
    return
  }
  const latest = latestContextOf(context)
  if (!latest.channel.enableRemoteFileApi) {
    // 用户已关闭远端文档解析：草稿附件只在本地移除
    return
  }
  if (!remoteFileOriginMatches(latest, origin)) {
    return
  }
  try {
    if (latest.mode === 'server') {
      await fetch('/api/files', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'X-Console-Token': latest.token,
        },
        body: JSON.stringify({ slot: latest.slot, fileId }),
        cache: 'no-store',
      })
      return
    }
    const url = normalizeFilesUrl(latest.channel)
    if (!url.ok) {
      return
    }
    const headers: Record<string, string> = {
      'anthropic-version': '2023-06-01',
      'anthropic-beta': FILES_BETA,
    }
    const apiKey = latest.channel.apiKey.trim()
    if (apiKey) {
      headers['x-api-key'] = apiKey
    }
    for (const header of latest.channel.customHeaders) {
      if (header.name && header.value) {
        headers[header.name] = header.value
      }
    }
    await fetch(`${url.url}/${encodeURIComponent(fileId)}`, {
      method: 'DELETE',
      headers,
      cache: 'no-store',
    })
  } catch {
    // 远端清理失败不影响本地会话
  }
}

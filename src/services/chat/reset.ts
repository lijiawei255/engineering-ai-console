/**
 * 数据导出与分级复位中的破坏性操作。
 *
 * 硬复位顺序（任何一步失败都必须保持数据可恢复）：
 * 1. 只中止在途流并把未完成消息收敛为 stopped，不动应急快照 / 草稿 / 内存会话；
 * 2. 可选：用合并了 IndexedDB、应急快照与内存缓存的抢救包导出完整回复；
 *    全库读取严格完整（瞬态中止自动重试一次），读取失败立即中止复位，绝不下载残缺文件；
 * 3. 清空 IndexedDB；
 * 4. 仅在清库事务成功提交之后，才清应急快照、草稿、内存会话与本地配置；
 * 5. 填回保留的密钥并重载页面。全程不动服务端 .console_data/。
 */

import { showToast } from '../../components/base/toastState.js'
import {
  collectLocalSecrets,
  resetConfigToDefaults,
  restoreLocalSecrets,
} from '../config/store.js'
import {
  buildJsonBackupFromSources,
  buildPlainTextBackup,
  parseJsonBackup,
  restoreJsonBackup,
} from './backup.js'
import { clearDatabase } from './db.js'
import {
  adoptImportedSessions,
  beginHardReset,
  clearLocalStateAfterDatabasePurge,
  initChat,
  persistSettledSessions,
  selectSession,
  settleInterruptedMessages,
  useChatStore,
  waitForPendingSaves,
} from './store.js'

const backupFilename = (prefix: string, extension: string): string => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return `${prefix}-${stamp}.${extension}`
}

const downloadTextFile = (text: string, filename: string, mime: string) => {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** 导出纯文本抢救包；备份读取失败或备份文本为空均视为失败，硬复位据此中止 */
export const exportChatBackup = async (): Promise<boolean> => {
  let result
  try {
    // 默认读取入口启用严格完整性守卫，并已合并数据库、应急快照与内存缓存：
    // 只存在于内存里的会话也能导出，而数据库全库读取失败时宁可报错也不导出残缺包。
    result = await buildPlainTextBackup()
  } catch {
    // 用户主动导出时的失败来自浏览器 IndexedDB 全库读取不完整：这里使用会话读取
    // 失败文案；resetBackupFailed 只用于硬复位被抢救包完整性中止的场景。
    showToast({ key: 'sessionReadFailed', type: 'error' })
    return false
  }
  if (result.sessionCount === 0 || !result.text.trim()) {
    showToast({ key: 'resetExportEmpty' })
    return false
  }
  downloadTextFile(
    result.text,
    backupFilename('engineering-ai-console-chats', 'txt'),
    'text/plain'
  )
  showToast({ key: 'exportDone' })
  return true
}

export type HardResetFailure = 'backupFailed' | 'databaseBlocked' | 'databaseFailed'

export type HardResetResult = { ok: true } | { ok: false; reason: HardResetFailure }

/** 导出结构化 JSON 备份：完整消息树与附件文本，不含任何密钥 */
export const exportJsonBackup = async (): Promise<boolean> => {
  // 与纯文本抢救包共用三源合并入口：应急快照 / 仅内存会话同样完整进入 JSON
  const backup = await buildJsonBackupFromSources()
  if (backup.sessions.length === 0) {
    showToast({ key: 'resetExportEmpty' })
    return false
  }
  downloadTextFile(
    JSON.stringify(backup, null, 2),
    backupFilename('engineering-ai-console-chats', 'json'),
    'application/json'
  )
  showToast({ key: 'exportJsonDone' })
  return true
}

export type ImportJsonResult =
  | { ok: true; sessions: number; messages: number }
  | {
      ok: false
      reason: 'invalid' | 'empty' | 'failed' | 'tooLarge' | 'tooMany'
      message?: string
    }

/** 导入 JSON 备份：严格校验后写入 IndexedDB（同 id 冲突生成新 id），并刷新会话列表 */
export const importJsonBackup = async (raw: string): Promise<ImportJsonResult> => {
  const parsed = parseJsonBackup(raw)
  if (!parsed.ok) {
    if (parsed.kind === 'tooLarge') {
      return { ok: false, reason: 'tooLarge' }
    }
    if (parsed.kind === 'tooMany') {
      return { ok: false, reason: 'tooMany' }
    }
    return { ok: false, reason: 'invalid', message: parsed.error }
  }
  if (parsed.sessions.length === 0) {
    return { ok: false, reason: 'empty' }
  }
  try {
    // 整份备份在单个 IndexedDB 事务里原子写入；中途异常会自动整批回滚
    const result = await restoreJsonBackup(parsed.sessions)
    // 导入成功后只接管本次真正写入的会话 ID：adoptImportedSessions 会中止这些 id 的在途
    // 流、递增各自的版本号、解除墓碑并只剔除它们的缓存条目；全局缓存、后台正在流式生成
    // 的无关会话以及欢迎页 / 其它会话的未发草稿必须保持原样，绝不清空整个 sessionCache。
    const activeId = adoptImportedSessions(result.ids)
    // initChat 只刷新摘要并补读本地草稿（内存中更新的草稿优先），不会重置其它会话的草稿。
    await initChat()
    if (activeId) {
      // 重新加载当前选中会话正文；若该会话已不存在则退回欢迎页，避免悬空选中态
      if (useChatStore.getState().summaries.some((summary) => summary.id === activeId)) {
        await selectSession(activeId)
      } else {
        useChatStore.setState({ activeId: null })
      }
    }
    return { ok: true, sessions: result.sessions, messages: result.messages }
  } catch (error) {
    return {
      ok: false,
      reason: 'failed',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * 复位成功后的整页重载入口。集中在一处：浏览器自检需要在不卸载测试页面的前提下
 * 验证成功路径，只能替换这一层，不能依赖对 location（不可重写）做手脚。
 */
let reloadAfterReset = () => location.reload()

export const setReloadAfterReset = (hook: (() => void) | null) => {
  reloadAfterReset = hook ?? (() => location.reload())
}

/**
 * 硬复位阶段一：停流、收敛消息、等待在途写盘落地，并为刚收敛的会话补一次落盘。
 *
 * 只做不可逆操作之前的准备：应急快照、草稿、内存会话与配置全部保持原样，
 * 供紧接着的抢救包导出和（失败时）刷新后的恢复使用。
 *
 * 收敛后的落盘顺序不可颠倒：beginHardReset() 已同步写下应急快照，这里先排空旧代次
 * 的在途写盘，再以最新 resetEpoch 逐一保存收敛后的会话。这样 IndexedDB 里原本的
 * `status: 'pending', content: ''` 会被替换成 `stopped` + 已显示的半截正文；即便写库
 * 事务也被极端故障注入中止，应急快照仍可用于刷新后的恢复。
 */
export const prepareHardReset = async (): Promise<void> => {
  const settled = beginHardReset()
  await waitForPendingSaves()
  await persistSettledSessions(settled)
}

/**
 * 硬复位阶段三与四：清库 → 清本地状态。
 *
 * clearDatabase() 事务成功提交之后才允许清应急快照、草稿与内存会话；
 * 事务被 abort / 抛错时保留全部三处数据，页面重载后仍能从应急快照恢复完整回复。
 */
const purgeDatabaseAndLocalState = async (): Promise<HardResetResult> => {
  try {
    // 单事务原子清空所有 object store：不删除数据库本身，其他标签页连接保持有效
    await clearDatabase()
  } catch {
    settleInterruptedMessages()
    return { ok: false, reason: 'databaseFailed' }
  }
  clearLocalStateAfterDatabasePurge()
  resetConfigToDefaults()
  return { ok: true }
}

/**
 * 硬复位的“数据破坏部分”（不带备份、不重载页面）：先停流，再清库；
 * 清库成功后才清应急快照、草稿、内存会话与本地配置。
 */
export const hardResetLocalData = async (): Promise<HardResetResult> => {
  await prepareHardReset()
  return purgeDatabaseAndLocalState()
}

/**
 * 硬复位。失败时返回原因而不 reload，界面保持弹窗并展示对应提示。
 *
 * 时序就是安全边界：先停流（阶段一），再从合并三源的抢救包导出完整回复（阶段二），
 * 然后清库（阶段三），只有清库成功才清应急快照 / 草稿 / 内存会话与配置（阶段四）。
 * 最后才填回保留密钥并重载页面；任何一步失败都保持数据可恢复。
 */
export const hardReset = async (options: {
  exportBackup: boolean
  keepKeys: boolean
}): Promise<HardResetResult> => {
  const secrets = options.keepKeys
    ? collectLocalSecrets()
    : { primary: '', backup: '', exa: '' }
  await prepareHardReset()
  if (options.exportBackup) {
    let backup = ''
    try {
      // 严格完整性读取：全库读取失败（含重试后仍失败）直接抛错，绝不能静默退化成
      // “只有缓存里几条会话”的残缺抢救包——那样一旦下载成功就会放行后续清库。
      backup = (await buildPlainTextBackup()).text
    } catch {
      // 备份生成 / 全库读取失败：立即中止硬复位。此时绝不调用 clearDatabase()，
      // 也不清应急快照、草稿与内存会话，更不触发残缺文件的下载。
      return { ok: false, reason: 'backupFailed' }
    }
    if (backup.trim()) {
      downloadTextFile(
        backup,
        backupFilename('engineering-ai-console-chats-before-reset', 'txt'),
        'text/plain'
      )
    } else if (
      useChatStore.getState().summaries.length > 0 ||
      Object.keys(useChatStore.getState().sessionCache).length > 0
    ) {
      // 仍有会话却生成不出抢救包：内容不可信，直接中止复位而不是先毁数据
      return { ok: false, reason: 'backupFailed' }
    }
  }
  const purged = await purgeDatabaseAndLocalState()
  if (!purged.ok) {
    return purged
  }
  if (options.keepKeys) {
    restoreLocalSecrets(secrets)
  }
  reloadAfterReset()
  return { ok: true }
}

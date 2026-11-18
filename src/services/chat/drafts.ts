/**
 * 预写式草稿锁存：输入文字与文本类附件按会话节流写入 localStorage。
 *
 * 网络失败、看门狗中断或意外关页重启后草稿不丢字；仅在消息成功入列后清空。
 * 图片附件体积大且刷新后无法可靠恢复，只保留在内存中，恢复时给出提示。
 *
 * 存储键命名空间是严格单射的，任何合法会话 ID 都不可能撞上欢迎页键：
 * - 欢迎页（sessionId === null）：`eac:draft:welcome`
 * - 任意会话（含 ID 为 "welcome" / "new" / "s:xxx" / "__welcome__" 的会话）：
 *   `eac:draft:session:` + sessionId
 * 因此清除某个会话的草稿、或清空全部草稿，都不会误伤其它会话或欢迎页草稿。
 */

import { create } from 'zustand'
import type { Attachment } from '../attachments/index.js'

export interface Draft {
  text: string
  attachments: Attachment[]
  updatedAt: number
  /** 刷新后图片附件无法恢复 */
  imagesLost?: boolean
}

export const EMPTY_DRAFT: Draft = { text: '', attachments: [], updatedAt: 0 }

/** 欢迎页草稿键：与任何会话键都不重叠（会话键统一带 session: 前缀） */
const WELCOME_STORAGE_KEY = 'eac:draft:welcome'
/** 会话草稿键前缀：后面原样拼接会话 ID，保持单射 */
const SESSION_STORAGE_PREFIX = 'eac:draft:session:'

const storageKeyOf = (sessionId: string | null): string =>
  sessionId === null ? WELCOME_STORAGE_KEY : `${SESSION_STORAGE_PREFIX}${sessionId}`

/** 供界面按会话取草稿：Map 的键就是存储键本身，不再是会话 ID */
export const draftKeyOf = storageKeyOf

interface DraftState {
  drafts: Map<string, Draft>
}

export const useDrafts = create<DraftState>(() => ({ drafts: new Map() }))

export const getDraft = (sessionId: string | null): Draft =>
  useDrafts.getState().drafts.get(storageKeyOf(sessionId)) ?? EMPTY_DRAFT

const setDraft = (sessionId: string | null, draft: Draft) => {
  const key = storageKeyOf(sessionId)
  useDrafts.setState((state) => {
    const drafts = new Map(state.drafts)
    drafts.set(key, draft)
    return { drafts }
  })
}

const timers = new Map<string, ReturnType<typeof setTimeout>>()
/**
 * 每个会话草稿的单调修改版本号。
 * 发送消息时记录 sentRevision：异步落盘回调只有在版本号未变时才允许恢复发送副本，
 * 用户在等待落盘期间敲入的新草稿（版本号已递增）绝不能被旧回调覆盖。
 */
const revisions = new Map<string, number>()

export const getDraftRevision = (sessionId: string | null): number =>
  revisions.get(storageKeyOf(sessionId)) ?? 0

const bumpDraftRevision = (sessionId: string | null): number => {
  const key = storageKeyOf(sessionId)
  const next = (revisions.get(key) ?? 0) + 1
  revisions.set(key, next)
  return next
}

const persist = (sessionId: string | null, draft: Draft) => {
  const key = storageKeyOf(sessionId)
  const previous = timers.get(key)
  if (previous !== undefined) {
    clearTimeout(previous)
  }
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key)
      try {
        // 图片只保留在内存：data URL 体积大且刷新后无法还原，这里记录数量供恢复时提示
        const images = draft.attachments.filter((attachment) => attachment.kind === 'image')
        const payload = {
          text: draft.text,
          updatedAt: draft.updatedAt,
          hadImages: images.length > 0,
          attachments: draft.attachments.filter((attachment) => attachment.kind !== 'image'),
        }
        localStorage.setItem(key, JSON.stringify(payload))
      } catch {
        // 存储不可用或超额时只保留内存草稿
      }
    }, 350)
  )
}

const update = (
  sessionId: string | null,
  updater: (draft: Draft) => Draft,
  options: { persist: boolean } = { persist: true }
) => {
  const next = { ...updater(getDraft(sessionId)), updatedAt: Date.now() }
  setDraft(sessionId, next)
  bumpDraftRevision(sessionId)
  if (options.persist) {
    persist(sessionId, next)
  }
  return next
}

export const setDraftText = (sessionId: string | null, text: string) => {
  update(sessionId, (draft) => ({ ...draft, text }))
}

export const setDraftAttachments = (sessionId: string | null, attachments: Attachment[]) => {
  update(sessionId, (draft) => ({ ...draft, attachments, imagesLost: false }))
}

export const addDraftAttachment = (sessionId: string | null, attachment: Attachment) => {
  update(sessionId, (draft) => ({ ...draft, attachments: [...draft.attachments, attachment] }))
}

export const removeDraftAttachment = (sessionId: string | null, id: string) => {
  update(sessionId, (draft) => ({
    ...draft,
    attachments: draft.attachments.filter((attachment) => attachment.id !== id),
  }))
}

export const clearDraft = (sessionId: string | null) => {
  const key = storageKeyOf(sessionId)
  const timer = timers.get(key)
  if (timer !== undefined) {
    clearTimeout(timer)
    timers.delete(key)
  }
  useDrafts.setState((state) => {
    const drafts = new Map(state.drafts)
    drafts.delete(key)
    return { drafts }
  })
  try {
    localStorage.removeItem(key)
  } catch {
    // 忽略
  }
}

/** 图片仅无文字失败 / 回滚时恢复完整草稿（含图片） */
export const restoreDraft = (sessionId: string | null, text: string, attachments: Attachment[]) => {
  update(sessionId, (draft) => ({ ...draft, text, attachments, imagesLost: false }))
}

const parseDraft = (raw: string): Draft | null => {
  try {
    const payload = JSON.parse(raw) as {
      text?: unknown
      updatedAt?: unknown
      hadImages?: unknown
      attachments?: unknown
    }
    const text = typeof payload.text === 'string' ? payload.text : ''
    const attachments = Array.isArray(payload.attachments)
      ? (payload.attachments as Attachment[]).filter(
          (attachment) =>
            attachment &&
            typeof attachment.id === 'string' &&
            typeof attachment.name === 'string' &&
            attachment.kind !== 'image'
        )
      : []
    return {
      text,
      attachments,
      updatedAt: typeof payload.updatedAt === 'number' ? payload.updatedAt : Date.now(),
      // 原草稿带图片但图片本身没有持久化，恢复后明确提示
      imagesLost: payload.hadImages === true,
    }
  } catch {
    return null
  }
}

/** 启动时把本地草稿读回内存 */
export const loadDrafts = () => {
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index)
      if (!key) {
        continue
      }
      let sessionId: string | null
      if (key === WELCOME_STORAGE_KEY) {
        sessionId = null
      } else if (key.startsWith(SESSION_STORAGE_PREFIX)) {
        sessionId = key.slice(SESSION_STORAGE_PREFIX.length)
        if (!sessionId) {
          continue
        }
      } else {
        // 未知键（含早期版本可能遗留的其它格式）：本版本不读取、不删除，交由使用者自行清理
        continue
      }
      const raw = localStorage.getItem(key)
      if (!raw) {
        continue
      }
      const draft = parseDraft(raw)
      if (!draft) {
        continue
      }
      // 已有内存草稿（可能含尚未发出的图片、且是 350ms 防抖窗口内刚敲入的新文本）时，
      // 读盘结果只能是旧快照，绝不能回写覆盖；内存始终是唯一权威来源。
      const existing = useDrafts.getState().drafts.get(key)
      if (existing && existing.updatedAt >= draft.updatedAt) {
        continue
      }
      useDrafts.setState((state) => {
        const drafts = new Map(state.drafts)
        drafts.set(key, draft)
        return { drafts }
      })
    }
  } catch {
    // 存储不可用时忽略
  }
}

export const clearAllDrafts = () => {
  // 先掐掉所有待写计时器，避免复位后又把旧草稿写回本地
  for (const timer of timers.values()) {
    clearTimeout(timer)
  }
  timers.clear()
  revisions.clear()
  try {
    const keys: string[] = []
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index)
      // 只清理本版本的两个合法命名空间；绝不按宽泛前缀误删未知键
      if (key === WELCOME_STORAGE_KEY || key?.startsWith(SESSION_STORAGE_PREFIX)) {
        keys.push(key)
      }
    }
    for (const key of keys) {
      localStorage.removeItem(key)
    }
  } catch {
    // 忽略
  }
  useDrafts.setState({ drafts: new Map() })
}

/**
 * 会话持久化：IndexedDB（idb）。
 *
 * 浏览器数据库只保存会话与附件文本 / 图片 data URL，不保存任何密钥。
 * 读取时统一把半截流状态收敛为 stopped，避免刷新后界面卡在生成中。
 *
 * 两个 object store：
 * - sessions：完整消息树，只在加载 / 备份 / 恢复时全量读取；
 * - summaries：会话摘要，启动时只读这里，避免把大消息体全部搬进内存。
 * 旧库（version 1）升级时从 sessions 回填 summaries。
 *
 * 清空与导入都收敛在单个 readwrite 事务里：不调用会被其他标签页阻塞的
 * indexedDB.deleteDatabase()，也不允许导入中途留下“只写了一半”的脏状态。
 */

import { openDB, type IDBPDatabase } from 'idb'
import { createId } from '../../utils/id.js'
import {
  normalizeLoadedSession,
  toSessionSummary,
  type Session,
  type SessionSummary,
} from './types.js'

const DB_NAME = 'engineering-ai-console'
export const DB_VERSION = 2
const SESSIONS_STORE = 'sessions'
const SUMMARIES_STORE = 'summaries'

export class ImportDatabaseError extends Error {
  readonly code = 'failed'

  constructor(cause?: unknown) {
    super('database import failed')
    this.name = 'ImportDatabaseError'
    if (cause !== undefined) {
      this.cause = cause
    }
  }
}

let database: Promise<IDBPDatabase> | null = null

/**
 * 创建事务后立即消费一次 tx.done 的拒绝。
 *
 * idb 在 `db.transaction()` 时就把 tx.done 挂成 Promise；事务被 abort 或某个请求失败时，
 * 它会先以 AbortError 拒绝，而主调用链随后还会再收到一次拒绝。不在创建后同一行挂 catch，
 * 浏览器就会把那次无人消费的拒绝上报成全局 unhandledrejection。调用方仍通过
 * failTransaction / `await tx.done` 拿到唯一一次真正错误，两条路径互不干扰。
 */
const trackTransaction = <T extends { done: Promise<unknown> }>(tx: T): T => {
  void tx.done.catch(() => undefined)
  return tx
}

/**
 * 事务失败时统一收尾：中止事务、消费 idb 预挂的 tx.done rejection 并抛原始错误。
 *
 * 事务创建时已经由 trackTransaction 消费过一次 tx.done；这里再显式消费一次，
 * 保证调用方只看到一次错误，且后续 aborted 事务不会再派发全局 unhandledrejection。
 */
const failTransaction = (
  tx: { abort: () => void; done: Promise<unknown> },
  error: unknown
): never => {
  try {
    tx.abort()
  } catch {
    // 事务可能已经因写入异常自动中止
  }
  void tx.done.catch(() => undefined)
  throw error
}

/**
 * 只读事务的请求源：`get / getAll / count` 只在显式创建的 readonly 事务里调用。
 *
 * 不用 idb 的 `db.get()` / `db.getAll()` / `db.count()` 快捷方法：它们内部临时建事务，
 * 却只等待请求、不等待 `tx.done`，事务被原生 `IDBTransaction.abort()` 中止时那次
 * 未绑定 catch 的 `tx.done` 拒绝就会泄漏成浏览器全局 unhandledrejection。
 */
interface ReadOnlyStore {
  get: (key: IDBValidKey) => Promise<unknown>
  getAll: () => Promise<unknown>
  count: () => Promise<number>
}

/**
 * 在显式 readonly 事务里执行一次读取。
 *
 * 创建事务的同一行立即 `trackTransaction(tx)` 消费预挂的 `tx.done` 拒绝；请求与提交
 * 任一阶段失败都只向调用方抛一次原始错误，绝不留下全局未处理拒绝。
 */
const readInTransaction = async <T>(
  db: IDBPDatabase,
  storeName: string,
  read: (store: ReadOnlyStore) => Promise<T>
): Promise<T> => {
  const tx = trackTransaction(db.transaction(storeName, 'readonly'))
  try {
    const result = await read(tx.objectStore(storeName) as unknown as ReadOnlyStore)
    await tx.done
    return result
  } catch (error) {
    return failTransaction(tx, error)
  }
}

const countRecords = (db: IDBPDatabase, storeName: string): Promise<number> =>
  readInTransaction(db, storeName, (store) => store.count())

const getAllRecords = <T>(db: IDBPDatabase, storeName: string): Promise<T[]> =>
  readInTransaction(db, storeName, (store) => store.getAll()) as Promise<T[]>

const getRecord = <T>(
  db: IDBPDatabase,
  storeName: string,
  key: IDBValidKey
): Promise<T | undefined> =>
  readInTransaction(db, storeName, (store) => store.get(key)) as Promise<T | undefined>

/**
 * version 1 的库只有 sessions：升级到 2 之后按需把摘要回填一次。
 * 放在 open 之后而非 upgrade 回调里，避免在 versionchange 事务里跨 await 排队写入。
 */
const backfillSummariesIfNeeded = async (db: IDBPDatabase): Promise<void> => {
  const summaryCount = await countRecords(db, SUMMARIES_STORE)
  if (summaryCount > 0) {
    return
  }
  const sessionCount = await countRecords(db, SESSIONS_STORE)
  if (sessionCount === 0) {
    return
  }
  const sessions = await getAllRecords<Session>(db, SESSIONS_STORE)
  const tx = trackTransaction(db.transaction(SUMMARIES_STORE, 'readwrite'))
  try {
    await Promise.all(
      sessions.map((session) => tx.store.put(toSessionSummary(normalizeLoadedSession(session))))
    )
    await tx.done
  } catch (error) {
    failTransaction(tx, error)
  }
}

const open = (): Promise<IDBPDatabase> => {
  if (!database) {
    const opening = openDB(DB_NAME, DB_VERSION, {
      upgrade(db, _oldVersion, _newVersion, transaction) {
        // versionchange 升级事务也在 idb 创建时预挂了 tx.done；升级被原生 abort 时
        // 若不在这里立即消费一次，AbortError 就会成为全局 unhandledrejection。
        void transaction.done.catch(() => undefined)
        if (!db.objectStoreNames.contains(SESSIONS_STORE)) {
          db.createObjectStore(SESSIONS_STORE, { keyPath: 'id' })
        }
        if (!db.objectStoreNames.contains(SUMMARIES_STORE)) {
          db.createObjectStore(SUMMARIES_STORE, { keyPath: 'id' })
        }
      },
      blocking() {
        // 其他标签页升级数据库时主动让出连接，避免其升级请求长期阻塞
        const current = database
        database = null
        void current?.then((db) => db.close()).catch(() => undefined)
      },
      terminated() {
        database = null
      },
    }).then(async (db) => {
      // 其他标签页请求升级时关闭本连接并丢弃缓存；下一次访问会重新打开
      db.addEventListener('versionchange', () => {
        db.close()
        database = null
      })
      await backfillSummariesIfNeeded(db)
      return db
    })
    database = opening
    opening.catch(() => {
      database = null
    })
  }
  return database
}

export const listSessionSummaries = async (): Promise<SessionSummary[]> => {
  const db = await open()
  // 只读摘要 store，不触碰完整消息树；事务在辅助函数里显式创建并消费 tx.done
  const summaries = await getAllRecords<SessionSummary>(db, SUMMARIES_STORE)
  return summaries.sort((left, right) => right.updatedAt - left.updatedAt)
}

export const loadSession = async (id: string): Promise<Session | null> => {
  const db = await open()
  const session = await getRecord<Session>(db, SESSIONS_STORE, id)
  return session ? normalizeLoadedSession(session) : null
}

/** 全量读取完整会话树，供备份与数据恢复使用 */
export const loadAllSessions = async (): Promise<Session[]> => {
  const db = await open()
  const sessions = await getAllRecords<Session>(db, SESSIONS_STORE)
  return sessions
    .map((session) => normalizeLoadedSession(session))
    .sort((left, right) => right.updatedAt - left.updatedAt)
}

/**
 * 写入单条会话与摘要：创建事务后同一行挂上 tx.done 消费，末尾显式等待提交完成。
 * 任一阶段（写入请求 / 提交）被原生 abort 都只向调用方抛一次错误，不产生全局未处理拒绝。
 */
export const saveSession = async (session: Session): Promise<void> => {
  const db = await open()
  // 创建事务的同一行立即挂上 tx.done 的消费；任何后续 await 之前都不得留空档
  const tx = trackTransaction(
    db.transaction([SESSIONS_STORE, SUMMARIES_STORE], 'readwrite')
  )
  try {
    await Promise.all([
      tx.objectStore(SESSIONS_STORE).put(session),
      tx.objectStore(SUMMARIES_STORE).put(toSessionSummary(session)),
    ])
    // 写入操作末尾显式等待提交完成：成功才代表事务真正落盘
    await tx.done
  } catch (error) {
    failTransaction(tx, error)
  }
}

export const deleteSessionRecord = async (id: string): Promise<void> => {
  const db = await open()
  const tx = trackTransaction(
    db.transaction([SESSIONS_STORE, SUMMARIES_STORE], 'readwrite')
  )
  try {
    await Promise.all([
      tx.objectStore(SESSIONS_STORE).delete(id),
      tx.objectStore(SUMMARIES_STORE).delete(id),
    ])
    await tx.done
  } catch (error) {
    failTransaction(tx, error)
  }
}

/**
 * 单事务清空所有 object store。
 * 不删除数据库本身：不会产生会被跨标签页阻塞、失败返回后又在后台偷偷执行的
 * deleteDatabase 僵尸请求，也不会让其他已打开标签页的连接失效。
 */
export const clearDatabase = async (): Promise<void> => {
  const db = await open()
  const stores = Array.from(db.objectStoreNames)
  if (stores.length === 0) {
    return
  }
  const tx = trackTransaction(db.transaction(stores, 'readwrite'))
  try {
    await Promise.all(stores.map((name) => tx.objectStore(name).clear()))
    await tx.done
  } catch (error) {
    failTransaction(tx, error)
  }
}

export const clearAllSessions = async (): Promise<void> => clearDatabase()

/** 原子导入结果：写入数量统计 + 实际写入的会话 ID */
export interface AtomicImportResult {
  sessions: number
  messages: number
  /** 实际写入的会话 ID（同 id 冲突时已换成新 id），导入后据此解除墓碑 / 刷新缓存 */
  ids: string[]
}

/**
 * JSON 备份导入：整份备份收敛在同一个 readwrite 事务里，put 幂等写入。
 * 同 id 已存在（含本批次内重复）时生成新 id，绝不覆盖既有会话；
 * 任一写入失败（含 QuotaExceededError）时 IndexedDB 原生事务自动整批回滚，
 * 调用方只会看到完整成功或完整失败，不会留下半截导入。
 */
export const importSessionsAtomically = async (
  sessions: Session[]
): Promise<AtomicImportResult> => {
  if (sessions.length === 0) {
    return { sessions: 0, messages: 0, ids: [] }
  }
  const db = await open()
  const tx = trackTransaction(
    db.transaction([SESSIONS_STORE, SUMMARIES_STORE], 'readwrite')
  )
  const sessionStore = tx.objectStore(SESSIONS_STORE)
  const summaryStore = tx.objectStore(SUMMARIES_STORE)
  let sessionCount = 0
  let messageCount = 0
  const ids: string[] = []
  try {
    for (const session of sessions) {
      // 同一事务内先写后读可见，因此本批次重复 id 也会被识别并换新
      const existing = await sessionStore.getKey(session.id)
      const id = existing !== undefined ? createId() : session.id
      const next: Session = { ...session, id }
      await Promise.all([
        sessionStore.put(next),
        summaryStore.put(toSessionSummary(next)),
      ])
      sessionCount += 1
      messageCount += next.messages.length
      ids.push(id)
    }
    await tx.done
  } catch (error) {
    try {
      tx.abort()
    } catch {
      // 事务可能已经因写入异常自动中止
    }
    // 事务中止会让 idb 在创建事务时预先挂好的 tx.done 以 AbortError 拒绝。
    // trackTransaction 与这里各显式消费一次，浏览器绝不会派发全局 unhandledrejection；
    // 调用方仍会收到携带真正根因（如 QuotaExceededError）的 ImportDatabaseError。
    void tx.done.catch(() => undefined)
    throw new ImportDatabaseError(error)
  }
  return { sessions: sessionCount, messages: messageCount, ids }
}

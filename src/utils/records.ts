/**
 * 以动态 ID 为键的字典查表工具。
 *
 * 会话 ID / 消息 ID 来自备份导入或浏览器数据库，用户可构造出 "toString"、
 * "constructor"、"__proto__" 这类原型链键。直接 obj[key] 会把继承来的函数
 * 误认成已加载的会话对象，因此统一先做自有属性判定。
 */
export const hasOwnKey = (record: object, key: PropertyKey): boolean =>
  Object.hasOwn(record, key)

export const ownValue = <T,>(record: Record<string, T>, key: string): T | undefined =>
  hasOwnKey(record, key) ? record[key] : undefined

/** 动态键写入：对象字面量里 __proto__ 作为普通数据键写入，不会改动原型 */
export const withOwnValue = <T,>(
  record: Record<string, T>,
  key: string,
  value: T
): Record<string, T> => ({ ...record, [key]: value })

/**
 * 动态键写入必须走 defineProperty：`next[key] = value` 遇到 "__proto__" 会触发
 * Object.prototype 的 setter，把值写进原型而不是创建自有数据键。
 */
const defineOwnValue = <T,>(record: Record<string, T>, key: string, value: T): void => {
  Object.defineProperty(record, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  })
}

export const withoutKey = <T,>(record: Record<string, T>, key: string): Record<string, T> => {
  const next: Record<string, T> = {}
  for (const [entryKey, value] of Object.entries(record)) {
    if (entryKey !== key) {
      defineOwnValue(next, entryKey, value)
    }
  }
  return next
}

import { useConfigStore } from '../services/config/store.js'
import type { Locale } from '../services/config/types.js'
import { en } from './en.js'
import { fr } from './fr.js'
import { ru } from './ru.js'
import { zh } from './zh.js'

export type TranslationKey = keyof typeof en
export type TranslationParams = Record<string, string | number>
export type TranslationMessage = { key: TranslationKey; params?: TranslationParams }
/** 带文字链接与错误图标的轻提示 */
export type LinkedMessage = TranslationMessage & {
  type?: 'error'
  link?: { key: TranslationKey; href: string }
}

export const isTranslationKey = (value: unknown): value is TranslationKey =>
  typeof value === 'string' && Object.hasOwn(en, value)

const createTranslate =
  (messages: Record<TranslationKey, string>) =>
  (key: TranslationKey, params?: TranslationParams): string =>
    messages[key].replace(/\{(\w+)\}/g, (placeholder, name: string) => {
      const value = params?.[name]
      return typeof value === 'string' || typeof value === 'number' ? String(value) : placeholder
    })

const translators: Record<Locale, ReturnType<typeof createTranslate>> = {
  en: createTranslate(en),
  zh: createTranslate(zh),
  fr: createTranslate(fr),
  ru: createTranslate(ru),
}

/** 组件订阅语言变化；普通函数调用时读取当前语言 */
export const useTranslate = () =>
  useConfigStore((state) => translators[state.settings.ui.locale])

export const useLocale = (): Locale =>
  useConfigStore((state) => state.settings.ui.locale)

export const translate = (key: TranslationKey, params?: TranslationParams): string =>
  translators[useConfigStore.getState().settings.ui.locale](key, params)

export const localeText = (locale: Locale, key: TranslationKey, params?: TranslationParams) =>
  translators[locale](key, params)

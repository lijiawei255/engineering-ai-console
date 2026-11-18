import { useSyncExternalStore } from 'react'
import { setUiSettings, useConfigStore } from '../services/config/store.js'

export type Theme = 'light' | 'dark'

const query = window.matchMedia('(prefers-color-scheme: dark)')

const subscribeOsTheme = (listener: () => void) => {
  query.addEventListener('change', listener)
  return () => query.removeEventListener('change', listener)
}

const getOsTheme = (): Theme => (query.matches ? 'dark' : 'light')

/** 当前实际生效的深浅色：手动选择优先，「跟随系统」时取系统设置 */
export const useTheme = (): Theme => {
  const preference = useConfigStore((state) => state.settings.ui.themePreference)
  const osTheme = useSyncExternalStore(subscribeOsTheme, getOsTheme)
  return preference === 'system' ? osTheme : preference
}

const syncPageBackground = () => {
  const backgroundColor = getComputedStyle(document.body).backgroundColor
  document.documentElement.style.backgroundColor = backgroundColor
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', backgroundColor)
}

const applyTheme = (theme: Theme) => {
  const body = document.body
  body.classList.add('change-theme')
  body.classList.toggle('dark', theme === 'dark')
  body.classList.toggle('light', theme === 'light')
  if (theme === 'dark') {
    body.setAttribute('data-ds-dark-theme', 'dark')
  } else {
    body.removeAttribute('data-ds-dark-theme')
  }
  document.documentElement.style.colorScheme = theme
  if (document.readyState === 'complete') {
    syncPageBackground()
  }
  setTimeout(() => body.classList.remove('change-theme'), 0)
}

let appliedTheme: Theme | null = null

const syncTheme = () => {
  const preference = useConfigStore.getState().settings.ui.themePreference
  const theme = preference === 'system' ? getOsTheme() : preference
  if (theme !== appliedTheme) {
    appliedTheme = theme
    applyTheme(theme)
  }
}

/** 首屏渲染前同步应用一次，之后随主题设置与系统深浅色变化更新 */
export const setupTheme = () => {
  syncTheme()
  if (document.readyState !== 'complete') {
    window.addEventListener('load', syncPageBackground, { once: true })
  }
  query.addEventListener('change', syncTheme)
  useConfigStore.subscribe(syncTheme)
}

let appliedScale = -1
let appliedWidth = ''
let appliedFlicker: boolean | null = null
let appliedLocale = ''

const applyLayout = () => {
  const ui = useConfigStore.getState().settings.ui
  if (ui.fontScale !== appliedScale) {
    appliedScale = ui.fontScale
    document.documentElement.style.setProperty('--console-font-scale', String(ui.fontScale))
  }
  if (ui.contentWidth !== appliedWidth) {
    appliedWidth = ui.contentWidth
    document.body.setAttribute('data-content-width', ui.contentWidth)
  }
  if (ui.reduceFlicker !== appliedFlicker) {
    appliedFlicker = ui.reduceFlicker
    document.body.setAttribute('data-reduce-flicker', String(ui.reduceFlicker))
  }
  if (ui.locale !== appliedLocale) {
    appliedLocale = ui.locale
    document.documentElement.lang = ui.locale
  }
}

/** 字号缩放、版心宽度、防闪烁与语言标记统一由配置状态驱动 */
export const setupFontScale = () => {
  applyLayout()
  useConfigStore.subscribe(applyLayout)
}

export const setThemePreference = (preference: 'light' | 'dark' | 'system') => {
  setUiSettings({ themePreference: preference })
}

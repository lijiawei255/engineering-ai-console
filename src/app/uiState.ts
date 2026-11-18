import { create } from 'zustand'

/**
 * 全局弹窗 / 抽屉状态。
 * 复位入口、设置入口不依赖会话渲染状态，任何卡死态都可点击打开。
 */
interface UiState {
  settingsOpen: boolean
  hardResetOpen: boolean
  mobileSiderOpen: boolean
  openSettings: () => void
  closeSettings: () => void
  openHardReset: () => void
  closeHardReset: () => void
  toggleMobileSider: () => void
  closeMobileSider: () => void
}

export const useUiStore = create<UiState>((set) => ({
  settingsOpen: false,
  hardResetOpen: false,
  mobileSiderOpen: false,
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  openHardReset: () => set({ hardResetOpen: true }),
  closeHardReset: () => set({ hardResetOpen: false }),
  toggleMobileSider: () => set((state) => ({ mobileSiderOpen: !state.mobileSiderOpen })),
  closeMobileSider: () => set({ mobileSiderOpen: false }),
}))

export const openSettings = () => useUiStore.getState().openSettings()
export const closeSettings = () => useUiStore.getState().closeSettings()
export const openHardReset = () => useUiStore.getState().openHardReset()
export const closeHardReset = () => useUiStore.getState().closeHardReset()
export const closeMobileSider = () => useUiStore.getState().closeMobileSider()

import { create } from 'zustand'
import type { LinkedMessage } from '../../i18n/index.js'

/** 轻提示：同一时间只显示一条，新的替换旧的，到时自动消失；文案在渲染时按当前语言翻译 */
type ToastState = { id: number; message: LinkedMessage | string | null; tone: 'error' | null }

export const useToast = create<ToastState>(() => ({ id: 0, message: null, tone: null }))

const BASE_DURATION = 3000
const LINK_DURATION = 5000
/** 长提示（如二进制附件拒止说明）按长度延长阅读时间，最多 9 秒 */
const durationOf = (message: LinkedMessage | string): number => {
  if (typeof message !== 'string') {
    return message.link ? LINK_DURATION : BASE_DURATION
  }
  return Math.min(LINK_DURATION + BASE_DURATION, BASE_DURATION + message.length * 50)
}

let timer: ReturnType<typeof setTimeout> | undefined

export const showToast = (message: LinkedMessage | string, tone?: 'error') => {
  if (timer !== undefined) {
    clearTimeout(timer)
  }
  useToast.setState((state) => ({
    id: state.id + 1,
    message,
    tone: tone ?? (typeof message !== 'string' && message.type === 'error' ? 'error' : null),
  }))
  timer = setTimeout(() => useToast.setState({ message: null, tone: null }), durationOf(message))
}

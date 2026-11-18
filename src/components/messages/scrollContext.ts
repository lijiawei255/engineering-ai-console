import { createContext, useContext } from 'react'

/** 消息列表提供的"跟随到底部"回调：流式渲染更新后触发 */
export const ScrollToBottomContext = createContext<() => void>(() => {})

export const useScrollToBottom = () => useContext(ScrollToBottomContext)

export const ScrollToBottomProvider = ScrollToBottomContext.Provider

import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import type { Session } from '../../services/chat/types.js'
import { IconChevronDownOutline14 } from '../base/icons.js'
import { AssistantMessage } from './AssistantMessage.js'
import { UserMessage } from './UserMessage.js'
import { ScrollToBottomProvider } from './scrollContext.js'
import styles from './MessageList.module.css'

/** 消息滚动区：贴底时自动跟随新内容，用户上翻后不再强行拉回 */
export const MessageList = ({ session }: { session: Session }) => {
  const t = useTranslate()
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const [atBottom, setAtBottom] = useState(true)

  const scrollToBottom = useCallback(() => {
    const element = scrollRef.current
    if (!element || !stickRef.current) {
      return
    }
    element.scrollTop = element.scrollHeight
  }, [])

  const handleScroll = () => {
    const element = scrollRef.current
    if (!element) {
      return
    }
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 140
    stickRef.current = nearBottom
    setAtBottom(nearBottom)
  }

  const last = session.messages[session.messages.length - 1]
  const lastLength = last
    ? last.content.length + (last.role === 'assistant' ? (last.reasoning?.length ?? 0) : 0)
    : 0

  useLayoutEffect(() => {
    stickRef.current = true
    setAtBottom(true)
    const element = scrollRef.current
    if (element) {
      element.scrollTop = element.scrollHeight
    }
  }, [session.id])

  useLayoutEffect(() => {
    scrollToBottom()
  }, [session.messages.length, lastLength, scrollToBottom])

  return (
    <ScrollToBottomProvider value={scrollToBottom}>
      <div className={styles.scroll} ref={scrollRef} onScroll={handleScroll}>
        <div className={styles.inner}>
          {session.messages.map((message) =>
            message.role === 'user' ? (
              <UserMessage key={message.id} message={message} sessionId={session.id} />
            ) : (
              <AssistantMessage key={message.id} message={message} sessionId={session.id} />
            )
          )}
        </div>
      </div>
      {!atBottom ? (
        <button
          type="button"
          className={styles.jump}
          aria-label={t('scrollToBottom')}
          onClick={() => {
            stickRef.current = true
            const element = scrollRef.current
            if (element) {
              element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' })
            }
            setAtBottom(true)
          }}
        >
          <IconChevronDownOutline14 />
        </button>
      ) : null}
    </ScrollToBottomProvider>
  )
}

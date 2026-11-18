import { useTranslate } from '../../i18n/index.js'
import { useChatStore } from '../../services/chat/store.js'
import { ownValue } from '../../utils/records.js'
import { MessageList } from '../messages/MessageList.js'
import { Composer } from './Composer.js'
import styles from './SessionView.module.css'

/** 会话页：标题栏 + 消息滚动区 + 输入区 */
export const SessionView = () => {
  const t = useTranslate()
  const session = useChatStore((state) =>
    state.activeId ? ownValue(state.sessionCache, state.activeId) : undefined
  )
  if (!session) {
    return null
  }
  return (
    <div className={styles.view}>
      <div className={styles.header}>
        <div className={styles.title}>{session.title || t('untitledChat')}</div>
      </div>
      <div className={styles.body}>
        <MessageList session={session} />
      </div>
      <Composer sessionId={session.id} />
    </div>
  )
}

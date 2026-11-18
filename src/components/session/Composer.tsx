import { useTranslate } from '../../i18n/index.js'
import { useChatStore } from '../../services/chat/store.js'
import { hasOwnKey } from '../../utils/records.js'
import { ActionCapsules } from '../actions/ActionCapsules.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import styles from './Composer.module.css'

/**
 * 输入区：动作胶囊 + 输入框 + 常驻安全提示。
 * 欢迎页与会话页共用，胶囊状态由会话 store 管理（发送后自动恢复默认）。
 */
export const Composer = ({ sessionId }: { sessionId: string | null }) => {
  const t = useTranslate()
  const streaming = useChatStore((state) =>
    sessionId === null
      ? false
      : hasOwnKey(state.streaming, sessionId) && Boolean(state.streaming[sessionId])
  )
  return (
    <div className={styles.composer}>
      <div className={styles.constrain}>
        <ActionCapsules />
        <ChatInput sessionId={sessionId} />
        <div className={styles.footerLine}>
          <span className={styles.safety}>{t('safetyNotice')}</span>
          {streaming ? null : <span className={styles.hint}>{t('enterToSend')}</span>}
        </div>
      </div>
    </div>
  )
}

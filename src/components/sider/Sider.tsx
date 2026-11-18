import { useState } from 'react'
import { clsx } from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import { closeMobileSider } from '../../app/uiState.js'
import { useIsMobile } from '../../app/viewport.js'
import {
  deleteSession,
  selectSession,
  startNewChat,
  useChatStore,
} from '../../services/chat/store.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Modal } from '../base/Modal.js'
import { IconNewChatOutline20, IconTrashOutline16 } from '../base/icons.js'
import styles from './Sider.module.css'

const dateText = (timestamp: number): string => {
  const date = new Date(timestamp)
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** 会话侧栏：新建对话 + 历史列表 + 删除确认 */
export const Sider = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const summaries = useChatStore((state) => state.summaries)
  const activeId = useChatStore((state) => state.activeId)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)

  const pickSession = (id: string) => {
    void selectSession(id)
    if (isMobile) {
      closeMobileSider()
    }
  }

  return (
    <aside className={styles.sider}>
      <div className={styles.header}>
        <Button
          variant="outlined"
          size="s"
          block
          className={styles.newChat}
          onClick={() => {
            startNewChat()
            if (isMobile) {
              closeMobileSider()
            }
          }}
        >
          <IconNewChatOutline20 />
          <span>{t('newChat')}</span>
        </Button>
      </div>
      <div className={styles.list} role="list">
        <div className={styles.listHeading}>{t('chatHistory')}</div>
        {summaries.length === 0 ? <div className={styles.empty}>{t('noSessions')}</div> : null}
        {summaries.map((summary) => (
          <div
            key={summary.id}
            role="listitem"
            className={clsx(styles.item, summary.id === activeId && styles.active)}
            onClick={() => pickSession(summary.id)}
          >
            <button type="button" className={styles.itemMain}>
              <span className={styles.itemTitle}>{summary.title || t('untitledChat')}</span>
              <span className={styles.itemDate}>{dateText(summary.updatedAt)}</span>
            </button>
            <span className={styles.itemDelete}>
              <IconButton
                size="xs"
                tone="tertiary"
                icon={<IconTrashOutline16 />}
                tooltip={t('deleteChat')}
                onClick={(event) => {
                  event.stopPropagation()
                  setDeleteTarget(summary.id)
                }}
              />
            </span>
          </div>
        ))}
      </div>
      {deleteTarget ? (
        <Modal
          title={t('deleteChat')}
          closable
          onClose={() => setDeleteTarget(null)}
          footer={
            <>
              <Button variant="outlined" onClick={() => setDeleteTarget(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  void deleteSession(deleteTarget)
                  setDeleteTarget(null)
                }}
              >
                {t('delete')}
              </Button>
            </>
          }
        >
          {t('deleteChatConfirm')}
        </Modal>
      ) : null}
    </aside>
  )
}

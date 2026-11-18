import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { copyText } from '../../utils/clipboard.js'
import { buildCompactSummary, rewindTo, setCompact } from '../../services/chat/store.js'
import type { UserMessage as UserMessageType } from '../../services/chat/types.js'
import { showToast } from '../base/toastState.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { IconCopyOutline16, IconEditOutline16, IconRefreshOutline16, IconThinkOutline14 } from '../base/icons.js'
import { AttachmentChip } from '../files/AttachmentChip.js'
import { CompactDialog } from './CompactDialog.js'
import styles from './UserMessage.module.css'

const CAPSULE_LABEL_KEY = {
  agent2: 'capsuleTagAgent2',
  agent3: 'capsuleTagAgent3',
  distill: 'capsuleTagDistill',
} as const

/** 用户消息：文字气泡 + 附件卡片 + 单次动作徽标 + 回滚 / 瘦身 / 复制 */
export const UserMessage = ({
  message,
  sessionId,
}: {
  message: UserMessageType
  sessionId: string
}) => {
  const t = useTranslate()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [confirmRewind, setConfirmRewind] = useState(false)
  const compacted = Boolean(message.compact && message.compactText)
  const showSummary = compacted && !expanded

  const copy = async () => {
    if (await copyText(message.content)) {
      showToast({ key: 'copied' })
    } else {
      showToast({ key: 'copyFailed', type: 'error' })
    }
  }

  const openCompact = () => {
    setDialogOpen(true)
  }

  const runRewind = (force: boolean) => {
    const result = rewindTo(sessionId, message.id, force)
    if (result === 'ok') {
      setConfirmRewind(false)
      showToast({ key: 'rewindDone' })
      return
    }
    // 输入框里有未发送草稿：先让用户确认覆盖
    if (result === 'needs-confirm') {
      setConfirmRewind(true)
    }
  }

  return (
    <div className={styles.wrapper}>
      <div className={styles.bubble}>
        {message.attachments.length > 0 ? (
          <div className={styles.attachments}>
            {message.attachments.map((attachment) => (
              <AttachmentChip key={attachment.id} attachment={attachment} />
            ))}
          </div>
        ) : null}
        {showSummary ? (
          <div className={styles.summary}>
            <span className={styles.compactBadge}>{t('compactBadge')}</span>
            <div className={styles.summaryText}>{message.compactText}</div>
          </div>
        ) : (
          <div className={styles.content}>{message.content}</div>
        )}
        <div className={styles.meta}>
          {message.capsule ? (
            <span className={styles.capsuleBadge} title={t('capsuleInjectedNote')}>
              <IconThinkOutline14 />
              {t(CAPSULE_LABEL_KEY[message.capsule])}
            </span>
          ) : null}
          {compacted ? <span className={styles.compactBadge}>{t('compactBadge')}</span> : null}
        </div>
      </div>
      <div className={styles.actions}>
        <button type="button" className={styles.action} onClick={() => void copy()}>
          <IconCopyOutline16 />
          <span>{t('copy')}</span>
        </button>
        {compacted ? (
          <button
            type="button"
            className={styles.action}
            onClick={() => setExpanded((value) => !value)}
          >
            <IconThinkOutline14 />
            <span>{t(expanded ? 'hideOriginal' : 'expandOriginal')}</span>
          </button>
        ) : null}
        <button type="button" className={styles.action} onClick={openCompact}>
          <IconEditOutline16 />
          <span>{t('compactAction')}</span>
        </button>
        <button
          type="button"
          className={styles.action}
          onClick={() => runRewind(false)}
        >
          <IconRefreshOutline16 />
          <span>{t('rewind')}</span>
        </button>
      </div>
      {dialogOpen ? (
        <CompactDialog
          title={t('compactDialogTitle')}
          initial={
            message.compactText ||
            buildCompactSummary(
              message.content,
              t('compactDefaultMarker'),
              message.attachments
            )
          }
          hasAttachments={message.attachments.length > 0}
          onSave={(summary) => setCompact(sessionId, message.id, true, summary)}
          onClose={() => setDialogOpen(false)}
        />
      ) : null}
      {confirmRewind ? (
        <Modal
          title={t('rewindConfirmTitle')}
          closable
          onClose={() => setConfirmRewind(false)}
          footer={
            <>
              <Button variant="outlined" onClick={() => setConfirmRewind(false)}>
                {t('cancel')}
              </Button>
              <Button variant="primary" onClick={() => runRewind(true)}>
                {t('confirm')}
              </Button>
            </>
          }
        >
          <p>{t('rewindConfirmText')}</p>
        </Modal>
      ) : null}
    </div>
  )
}

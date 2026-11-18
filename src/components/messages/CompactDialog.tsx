import { useState, type CSSProperties } from 'react'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { useTranslate } from '../../i18n/index.js'
import styles from './CompactDialog.module.css'

const attachmentWarningStyle: CSSProperties = {
  marginBottom: 10,
  padding: '8px 10px',
  borderLeft: '3px solid var(--so-orange)',
  borderRadius: 6,
  background: 'var(--dsw-alias-bg-layer-3)',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 'calc(12px * var(--console-font-scale))',
  lineHeight: 1.6,
}

/** 上下文瘦身编辑：默认摘要可手改；保存后后续请求使用该摘要 */
export const CompactDialog = ({
  title,
  initial,
  hasAttachments = false,
  onSave,
  onClose,
}: {
  title: string
  initial: string
  /** 该消息带附件时提示摘要是后续上下文里附件内容的唯一来源 */
  hasAttachments?: boolean
  onSave: (summary: string) => void
  onClose: () => void
}) => {
  const t = useTranslate()
  const [value, setValue] = useState(initial)
  return (
    <Modal
      title={title}
      closable
      onClose={onClose}
      footer={
        <>
          <Button variant="outlined" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!value.trim()}
            onClick={() => {
              onSave(value.trim())
              onClose()
            }}
          >
            {t('confirm')}
          </Button>
        </>
      }
    >
      {hasAttachments ? (
        <div role="alert" style={attachmentWarningStyle}>
          {t('compactAttachmentWarning')}
        </div>
      ) : null}
      <div className={styles.hint}>{t('compactDialogHint')}</div>
      <label className={styles.label} htmlFor="compact-summary">
        {t('compactSummaryLabel')}
      </label>
      <textarea
        id="compact-summary"
        className={styles.textarea}
        value={value}
        placeholder={t('compactSummaryPlaceholder')}
        onChange={(event) => setValue(event.target.value)}
        rows={8}
      />
      <div className={styles.counter}>{t('charCount', { count: value.length })}</div>
    </Modal>
  )
}

import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { copyText } from '../../utils/clipboard.js'
import {
  buildCompactSummary,
  describeMessageError,
  retryAssistant,
  setAssistantCompact,
} from '../../services/chat/store.js'
import type { AssistantMessage as AssistantMessageType } from '../../services/chat/types.js'
import { Button } from '../base/Button.js'
import { IconCopyOutline16, IconEditOutline16, IconRefreshOutline16, IconThinkOutline14, IconWarningOutline16 } from '../base/icons.js'
import { Markdown } from '../markdown/Markdown.js'
import { showToast } from '../base/toastState.js'
import { useUiStore } from '../../app/uiState.js'
import { CompactDialog } from './CompactDialog.js'
import { ThinkingBlock } from './ThinkingBlock.js'
import styles from './AssistantMessage.module.css'

/** 1 号位回答：思考块 + Markdown 正文 + 错误恢复动作 + 瘦身 / 复制 */
export const AssistantMessage = ({
  message,
  sessionId,
}: {
  message: AssistantMessageType
  sessionId: string
}) => {
  const t = useTranslate()
  const openSettings = useUiStore((state) => state.openSettings)
  const [expanded, setExpanded] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const streaming = message.status === 'pending' || message.status === 'streaming'
  const compacted = Boolean(message.compact && message.compactText)
  const showSummary = compacted && !expanded
  const waiting = message.status === 'pending' && !message.content && !message.reasoning
  const errorInfo = message.error ? describeMessageError(message.error) : null
  const canRecover = message.status === 'error' || message.status === 'stopped'
  // 默认主/备名称跟随界面语言展示；自定义名称保持原样
  const channelLabel =
    message.channelLabel === 'Primary'
      ? t('channelPrimary')
      : message.channelLabel === 'Backup'
        ? t('channelBackup')
        : message.channelLabel

  const copy = async () => {
    if (await copyText(message.content)) {
      showToast({ key: 'copied' })
    } else {
      showToast({ key: 'copyFailed', type: 'error' })
    }
  }

  return (
    <div className={styles.wrapper}>
      <div className={styles.header}>
        <span className={styles.agent}>{t('agent1Name')}</span>
        {channelLabel || message.model ? (
          <span className={styles.meta}>
            {[channelLabel, message.model].filter(Boolean).join(' · ')}
          </span>
        ) : null}
        {streaming ? (
          <span className={styles.status} role="status">
            <span className="console-live-dot" aria-hidden />
            {t('streamingLabel')}
          </span>
        ) : null}
      </div>

      {message.reasoning ? (
        <ThinkingBlock
          reasoning={message.reasoning}
          seconds={message.reasoningMs}
          streaming={message.status === 'streaming'}
        />
      ) : null}

      {waiting ? <div className={styles.waiting}>{t('waitingFirstToken')}</div> : null}

      {showSummary ? (
        <div className={styles.summary}>
          <div className={styles.summaryHeader}>
            <span className={styles.compactBadge}>{t('compactBadge')}</span>
            <button type="button" className={styles.linkButton} onClick={() => setExpanded(true)}>
              {t('expandOriginal')}
            </button>
          </div>
          <div className={styles.summaryText}>{message.compactText}</div>
        </div>
      ) : message.content ? (
        <Markdown
          content={message.content}
          loading={message.status === 'streaming'}
          cacheKey={message.id}
          className={styles.markdown}
        />
      ) : null}

      {message.notice === 'modality-downgraded' ? (
        <div className={styles.notice}>
          <IconWarningOutline16 />
          <span>{t('imageOmittedToast')}</span>
        </div>
      ) : null}

      {errorInfo ? (
        <div className={styles.error} role="alert">
          <div className={styles.errorText}>
            <IconWarningOutline16 />
            <span>{t(errorInfo.key, errorInfo.params)}</span>
          </div>
          <div className={styles.errorActions}>
            {message.error?.kind === 'config' ? (
              <Button variant="outlined" size="s" onClick={openSettings}>
                {t('openSettings')}
              </Button>
            ) : null}
            <Button
              variant="outlined"
              size="s"
              onClick={() => {
                if (retryAssistant(sessionId, message.id, false)) {
                  showToast({ key: 'retry' })
                }
              }}
            >
              {t('retryRound')}
            </Button>
            <Button
              variant="outlined"
              size="s"
              onClick={() => {
                if (retryAssistant(sessionId, message.id, true)) {
                  showToast({ key: 'retryOnBackup' })
                }
              }}
            >
              {t('retryOnBackup')}
            </Button>
          </div>
        </div>
      ) : canRecover ? (
        <div className={styles.stopped}>
          <span>{message.status === 'stopped' ? t('stoppedByUser') : t('errorInterrupted')}</span>
          <div className={styles.errorActions}>
            <Button
              variant="outlined"
              size="s"
              onClick={() => {
                if (retryAssistant(sessionId, message.id, false)) {
                  showToast({ key: 'retry' })
                }
              }}
            >
              {t('retryRound')}
            </Button>
            <Button
              variant="outlined"
              size="s"
              onClick={() => {
                if (retryAssistant(sessionId, message.id, true)) {
                  showToast({ key: 'retryOnBackup' })
                }
              }}
            >
              {t('retryOnBackup')}
            </Button>
          </div>
        </div>
      ) : null}

      <div className={styles.footer}>
        <div className={styles.actions}>
          {message.content ? (
            <button type="button" className={styles.action} onClick={() => void copy()}>
              <IconCopyOutline16 />
              <span>{t('copy')}</span>
            </button>
          ) : null}
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
          {message.content ? (
            <button
              type="button"
              className={styles.action}
              onClick={() => setDialogOpen(true)}
            >
              <IconEditOutline16 />
              <span>{t('compactAction')}</span>
            </button>
          ) : null}
          {canRecover && message.status === 'error' ? (
            <button
              type="button"
              className={styles.action}
              onClick={() => retryAssistant(sessionId, message.id, false)}
            >
              <IconRefreshOutline16 />
              <span>{t('retryRound')}</span>
            </button>
          ) : null}
        </div>
        {message.usage && (message.usage.inputTokens || message.usage.outputTokens) ? (
          <div className={styles.usage}>
            {t('usageLabel', {
              input: message.usage.inputTokens ?? 0,
              output: message.usage.outputTokens ?? 0,
            })}
          </div>
        ) : null}
      </div>

      {dialogOpen ? (
        <CompactDialog
          title={t('compactDialogTitle')}
          initial={
            message.compactText ||
            buildCompactSummary(message.content, t('compactDefaultMarker'))
          }
          hasAttachments={false}
          onSave={(summary) => setAssistantCompact(sessionId, message.id, true, summary)}
          onClose={() => setDialogOpen(false)}
        />
      ) : null}
    </div>
  )
}

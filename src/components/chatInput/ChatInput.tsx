import { useLayoutEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import { useIsMobile } from '../../app/viewport.js'
import { showToast } from '../base/toastState.js'
import { IconButton } from '../base/IconButton.js'
import { Tooltip } from '../base/Tooltip.js'
import {
  IconGlobeLanguageOutline14,
  IconPaperclipOutline16,
  IconSendOutline16,
  IconStopFill16,
  IconThinkOutline14,
} from '../base/icons.js'
import {
  MAX_ATTACHMENTS,
  parseAttachmentFile,
  type Attachment,
} from '../../services/attachments/index.js'
import { deleteRemoteFile, type RemoteContext } from '../../services/api/files.js'
import {
  getServerToken,
  remoteKeyFingerprintOf,
  setThinking,
  setWebSearch,
  useConfigStore,
} from '../../services/config/store.js'
import { thinkingToggleHintKey } from '../../services/config/channelAdvanced.js'
import {
  EMPTY_DRAFT,
  draftKeyOf,
  getDraft,
  removeDraftAttachment,
  setDraftText,
  useDrafts,
} from '../../services/chat/drafts.js'
import {
  addParsedAttachmentIfAlive,
  getSessionRev,
  getWelcomeDraftRev,
  sendMessage,
  stopReply,
  useChatStore,
} from '../../services/chat/store.js'
import { hasOwnKey } from '../../utils/records.js'
import { AttachmentChip } from '../files/AttachmentChip.js'
import { DragMask, useFileDrop } from './DragMask.js'
import styles from './ChatInput.module.css'

const errorToastOf = (attachment: Attachment, t: ReturnType<typeof useTranslate>) => {
  switch (attachment.error) {
    case 'tooLarge':
      // 拒绝时附件已记录该类型自己的上限（图片 12 / 本地文件 16 / 远端 30 MiB）
      showToast(
        t('attachmentTooLarge', { size: attachment.limitMb ?? 16 }),
        'error'
      )
      return
    case 'officeTooLarge':
      showToast(t('attachmentOfficeTooLarge'), 'error')
      return
    case 'imageUnsupported':
      showToast(t('attachmentImageUnsupported'), 'error')
      return
    case 'officeFailed':
      showToast(t('attachmentOfficeFailed'), 'error')
      return
    case 'readFailed':
      showToast(t('attachmentReadFailed'), 'error')
      return
    case 'remoteFailed':
      showToast(`${t('attachmentReadFailed')} — ${attachment.errorDetail ?? ''}`, 'error')
      return
    case 'binaryUnsupported':
      showToast(t('attachmentBinaryUnsupported'), 'error')
      return
    default:
      showToast(t('attachmentUnsupported'), 'error')
  }
}

/** 输入框：自适应文本框 + 附件本地解析 + 深度思考 / 联网开关 + 发送 / 停止 */
export const ChatInput = ({ sessionId }: { sessionId: string | null }) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const draftKey = draftKeyOf(sessionId)
  const draft = useDrafts((state) => state.drafts.get(draftKey) ?? EMPTY_DRAFT)
  const streaming = useChatStore((state) =>
    sessionId === null
      ? false
      : hasOwnKey(state.streaming, sessionId) && Boolean(state.streaming[sessionId])
  )
  const settings = useConfigStore((state) => state.settings)
  const mode = useConfigStore((state) => state.mode)
  const channel = settings.channels[settings.activeChannel]
  const [parsing, setParsing] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) {
      return
    }
    textarea.style.height = 'auto'
    textarea.style.height = `${textarea.scrollHeight}px`
  }, [draft.text, sessionId])

  const usableAttachments = draft.attachments

  const addFiles = async (files: File[]) => {
    if (files.length === 0 || parsing) {
      return
    }
    const current = getDraft(sessionId).attachments
    const remaining = MAX_ATTACHMENTS - current.length
    if (remaining <= 0) {
      showToast(t('attachmentCountLimit', { count: MAX_ATTACHMENTS }), 'error')
      return
    }
    const accepted = files.slice(0, remaining)
    if (files.length > remaining) {
      showToast(t('attachmentCountLimit', { count: MAX_ATTACHMENTS }), 'error')
    }
    setParsing(true)
    // 解析是异步的：先固定目标会话、全局复位代次与该会话自己的版本号，每个文件解析完成
    // 后再核验一次。期间删除会话、导入同 ID 的新会话或软 / 硬复位都会让结果失效，
    // 绝不能把附件写回已删除 / 已被覆盖的草稿。
    const targetSessionId = sessionId
    const parseEpoch = useChatStore.getState().resetEpoch
    const parseSessionRev =
      targetSessionId === null ? getWelcomeDraftRev() : getSessionRev(targetSessionId)
    const remote =
      channel.enableRemoteFileApi && channel.protocol === 'anthropic'
        ? {
            mode,
            token: getServerToken(),
            slot: settings.activeChannel,
            channel,
            keyFingerprint: remoteKeyFingerprintOf(settings.activeChannel),
          }
        : null
    try {
      for (const file of accepted) {
        const attachment = await parseAttachmentFile(file, { remote })
        if (attachment.kind === 'rejected') {
          errorToastOf(attachment, t)
          continue
        }
        // 解析期间目标会话可能已被删除（或输入框已被复位）：直接丢弃，不写内存与 localStorage
        if (!addParsedAttachmentIfAlive(targetSessionId, parseEpoch, parseSessionRev, attachment)) {
          return
        }
      }
    } finally {
      setParsing(false)
    }
  }

  const removeAttachment = (id: string) => {
    const attachment = getDraft(sessionId).attachments.find((item) => item.id === id)
    removeDraftAttachment(sessionId, id)
    if (!attachment || attachment.kind !== 'remote' || !attachment.remoteFileId) {
      return
    }
    // 删除必须回到上传时的原槽位，并使用该槽位自己的通道配置与请求头；
    // 同时复核归属指纹：上传后改过该槽位的端点或密钥时，旧 file_id 属于另一个
    // 凭据空间，只做本地移除，绝不向新端点/新凭据发 DELETE。
    const uploadSlot = attachment.remoteChannel ?? settings.activeChannel
    const uploadChannel = settings.channels[uploadSlot]
    if (!uploadChannel.enableRemoteFileApi) {
      // 远端文档解析开关已关闭：仅在本地草稿中移除，不产生任何出站请求
      return
    }
    const context: RemoteContext = {
      mode,
      token: getServerToken(),
      slot: uploadSlot,
      channel: uploadChannel,
      keyFingerprint: remoteKeyFingerprintOf(uploadSlot),
    }
    // 请求入口会在发 DELETE 前先 ensureConfigSynced，再用同步后的最新端点与
    // 实际生效凭据复核一次归属，防抖窗口里的旧配置不会误发到新网关
    void deleteRemoteFile(context, attachment.remoteEndpoint, attachment.remoteFileId)
  }

  const dragging = useFileDrop((files) => {
    void addFiles(files)
  })

  const searchMode = channel.webSearchMode
  const nativeNeedsAnthropic = searchMode === 'native' && channel.protocol !== 'anthropic'
  const searchDisabled = searchMode === 'off' || nativeNeedsAnthropic
  const searchTooltip = searchDisabled
    ? t(searchMode === 'off' ? 'searchUnavailableOff' : 'searchUnavailableNative')
    : t('searchToggle')
  // 标准透传通道不附加任何思考参数：开关仍可切换到专用思考模型，但悬停时必须说明
  // “没有额外请求字段”，否则用户会误以为开关失效。
  const thinkingTooltip = t(thinkingToggleHintKey(channel))

  const canSend =
    !streaming && !parsing && (draft.text.trim().length > 0 || usableAttachments.length > 0)

  const send = () => {
    if (!canSend) {
      return
    }
    const sent = sendMessage({
      text: draft.text,
      attachments: usableAttachments,
      capsule: useChatStore.getState().pendingCapsule,
    })
    if (sent) {
      if (!isMobile) {
        textareaRef.current?.focus({ preventScroll: true })
      }
    }
  }

  return (
    <div
      className={styles.wrapper}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          textareaRef.current?.focus({ preventScroll: true })
        }
      }}
    >
      {usableAttachments.length > 0 ? (
        <div className={styles.attachmentRow}>
          {usableAttachments.map((attachment) => (
            <AttachmentChip
              key={attachment.id}
              attachment={attachment}
              onRemove={removeAttachment}
            />
          ))}
        </div>
      ) : null}
      {parsing ? (
        <div className={styles.parsing} role="status">
          {t('parsingFiles')}
        </div>
      ) : null}
      <textarea
        ref={textareaRef}
        className={styles.textarea}
        placeholder={t('inputPlaceholder')}
        rows={2}
        value={draft.text}
        autoFocus={!isMobile && sessionId === null}
        onChange={(event) => setDraftText(sessionId, event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            send()
          }
        }}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.files)
          if (files.length > 0) {
            event.preventDefault()
            void addFiles(files)
          }
        }}
      />
      {draft.imagesLost ? (
        <div className={styles.parsing} role="alert">
          {t('draftAttachmentLost')}
        </div>
      ) : null}
      <div className={styles.functionRow}>
        <div className={styles.toggles}>
          <Tooltip content={thinkingTooltip}>
            <button
              type="button"
              className={clsx(styles.toggle, settings.thinking && styles.selected)}
              aria-pressed={settings.thinking}
              aria-label={t('thinkingToggle')}
              onClick={() => setThinking(!settings.thinking)}
            >
              <IconThinkOutline14 />
              <span>{t('thinkingToggle')}</span>
            </button>
          </Tooltip>
          <Tooltip content={searchTooltip}>
            <button
              type="button"
              className={clsx(styles.toggle, settings.webSearch && !searchDisabled && styles.selected)}
              aria-pressed={settings.webSearch && !searchDisabled}
              aria-label={t('searchToggle')}
              disabled={searchDisabled}
              onClick={() => setWebSearch(!settings.webSearch)}
            >
              <IconGlobeLanguageOutline14 />
              <span>{t('searchToggle')}</span>
            </button>
          </Tooltip>
        </div>
        <div className={styles.right}>
          <IconButton
            size="m"
            tone="primary"
            icon={<IconPaperclipOutline16 />}
            tooltip={t('attachFile')}
            disabled={parsing}
            onClick={() => fileInputRef.current?.click()}
          />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              void addFiles(Array.from(event.target.files ?? []))
              event.target.value = ''
            }}
          />
          {streaming && sessionId ? (
            <button
              type="button"
              className={styles.sendButton}
              aria-label={t('stopGenerating')}
              onClick={() => stopReply(sessionId)}
            >
              <IconStopFill16 />
            </button>
          ) : (
            <button
              type="button"
              className={clsx(styles.sendButton, !canSend && styles.disabled)}
              aria-label={t('send')}
              aria-disabled={!canSend}
              onClick={send}
            >
              <IconSendOutline16 />
            </button>
          )}
        </div>
      </div>
      {dragging ? <DragMask /> : null}
    </div>
  )
}

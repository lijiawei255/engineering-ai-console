import clsx from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import type { Attachment } from '../../services/attachments/index.js'
import { formatSize, getFileExt } from '../../services/attachments/index.js'
import { IconCloseFill14 } from '../base/icons.js'
import { FileIcon } from './FileIcon.js'
import styles from './AttachmentChip.module.css'

/**
 * 附件卡片：图标（图片用本地缩略图）+ 文件名 + 大小与解析方式徽标。
 * 已截断附件明确标注；远端解析附件明确标注，避免误以为本地处理。
 */
export const AttachmentChip = ({
  attachment,
  onRemove,
}: {
  attachment: Attachment
  onRemove?: (id: string) => void
}) => {
  const t = useTranslate()
  const ext = getFileExt(attachment.name).toUpperCase()
  const description = formatSize(attachment.size)
  return (
    <div className={styles.chip} title={attachment.name}>
      <div className={styles.icon}>
        {attachment.kind === 'image' && attachment.dataUrl ? (
          <img className={styles.thumbnail} src={attachment.dataUrl} alt="" />
        ) : (
          <FileIcon ext={ext} />
        )}
      </div>
      <div className={styles.body}>
        <div className={styles.name}>{attachment.name}</div>
        <div className={styles.meta}>
          <span>{description}</span>
          {attachment.kind === 'remote' ? (
            <span className={styles.remoteBadge}>{t('attachmentRemote')}</span>
          ) : (
            <span className={styles.localBadge}>· {t('attachmentLocal')}</span>
          )}
          {attachment.truncated ? (
            <span className={clsx(styles.badge, styles.warn)}>{t('attachmentTruncated')}</span>
          ) : null}
        </div>
      </div>
      {onRemove ? (
        <button
          type="button"
          className={styles.remove}
          aria-label={t('remove')}
          onClick={() => onRemove(attachment.id)}
        >
          <IconCloseFill14 />
        </button>
      ) : null}
    </div>
  )
}

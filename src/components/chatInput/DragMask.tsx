import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import { MAX_ATTACHMENTS, MAX_LOCAL_FILE_BYTES } from '../../services/attachments/index.js'
import styles from './DragMask.module.css'

const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false

/** 拖拽上传：页面任意位置拖入文件即显示全屏遮罩，松手后交给 onDrop */
export const useFileDrop = (onDrop: (files: File[]) => void) => {
  const [dragging, setDragging] = useState(false)
  const onDropRef = useRef(onDrop)
  onDropRef.current = onDrop

  useEffect(() => {
    // dragenter / dragleave 会在子元素间反复触发，用计数判断是否真正离开页面
    let depth = 0
    const enter = (event: DragEvent) => {
      if (hasFiles(event)) {
        depth++
        setDragging(true)
      }
    }
    const leave = (event: DragEvent) => {
      if (hasFiles(event) && --depth <= 0) {
        depth = 0
        setDragging(false)
      }
    }
    const over = (event: DragEvent) => {
      if (hasFiles(event)) {
        event.preventDefault()
      }
    }
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) {
        return
      }
      event.preventDefault()
      depth = 0
      setDragging(false)
      onDropRef.current(Array.from(event.dataTransfer?.files ?? []))
    }
    document.addEventListener('dragenter', enter)
    document.addEventListener('dragleave', leave)
    document.addEventListener('dragover', over)
    document.addEventListener('drop', drop)
    return () => {
      document.removeEventListener('dragenter', enter)
      document.removeEventListener('dragleave', leave)
      document.removeEventListener('dragover', over)
      document.removeEventListener('drop', drop)
    }
  }, [])
  return dragging
}

/** 拖拽遮罩，挂到 body 上盖住整个页面 */
export const DragMask = () => createPortal(<DragMaskContent />, document.body)

const DragMaskContent = () => {
  const t = useTranslate()
  return (
    <div className={styles.mask}>
      <div className={styles.wrap}>
        <UploadIcon />
        <div className={styles.title}>{t('dropFiles')}</div>
        <div className={styles.desc}>
          {t('dropFilesHint', {
            count: MAX_ATTACHMENTS,
            size: Math.round(MAX_LOCAL_FILE_BYTES / (1024 * 1024)),
          })}
        </div>
      </div>
    </div>
  )
}

const UploadIcon = () => (
  <svg width="72" height="58" viewBox="0 0 72 58" fill="none" aria-hidden>
    <rect x="14" y="26" width="44" height="30" rx="6" fill="var(--so-base02)" />
    <path
      d="M36 8v30M24 20l12-12 12 12"
      stroke="var(--so-cyan)"
      strokeWidth="3.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

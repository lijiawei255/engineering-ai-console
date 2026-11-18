import { memo } from 'react'
import { useTranslate } from '../../i18n/index.js'
import styles from './ThinkingBlock.module.css'

/** 折叠思考块：显示耗时，默认收起；流式思考过程中保持展开 */
export const ThinkingBlock = memo(function ThinkingBlock({
  reasoning,
  seconds,
  streaming,
}: {
  reasoning: string
  seconds?: number
  streaming: boolean
}) {
  const t = useTranslate()
  return (
    <details className={styles.block} open={streaming || undefined}>
      <summary className={styles.summary}>
        <span className={styles.chevron} aria-hidden>
          ▸
        </span>
        <span className={styles.label}>{t('reasoningLabel')}</span>
        {seconds !== undefined ? (
          <span className={styles.duration}>{t('thoughtFor', { seconds })}</span>
        ) : null}
        {streaming ? <span className="console-live-dot" aria-hidden /> : null}
      </summary>
      <div className={styles.body}>{reasoning}</div>
    </details>
  )
})

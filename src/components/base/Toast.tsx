import clsx from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import { IconToastError16 } from './icons.js'
import { useToast } from './toastState.js'
import styles from './Toast.module.css'

export const Toast = () => {
  const t = useTranslate()
  const { id, message, tone } = useToast()
  if (!message) {
    return null
  }
  if (typeof message === 'string') {
    const error = tone === 'error'
    return (
      <div key={id} className={clsx(styles.toast, error && styles.error)} role="status">
        {error ? (
          <span className={styles.icon}>
            <IconToastError16 />
          </span>
        ) : null}
        <span className={styles.content}>{message}</span>
      </div>
    )
  }
  const error = message.type === 'error' || tone === 'error'
  return (
    <div key={id} className={clsx(styles.toast, error && styles.error)} role="status">
      {error ? (
        <span className={styles.icon}>
          <IconToastError16 />
        </span>
      ) : null}
      <span className={styles.content}>
        {t(message.key, message.params)}
        {message.link ? (
          <a className={styles.link} href={message.link.href} target="_blank" rel="noreferrer">
            {t(message.link.key)}
          </a>
        ) : null}
      </span>
    </div>
  )
}

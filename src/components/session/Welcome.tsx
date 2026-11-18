import { useTranslate } from '../../i18n/index.js'
import { Composer } from './Composer.js'
import styles from './Welcome.module.css'

/** 新对话：问候 + 说明 + 输入区；桌面端垂直居中 */
export const Welcome = () => {
  const t = useTranslate()
  return (
    <div className={styles.container}>
      <div className={styles.hero}>
        <div className={styles.badge}>{t('welcomeHint')}</div>
        <h1 className={styles.title}>{t('welcomeTitle')}</h1>
        <p className={styles.lead}>{t('welcomeLead')}</p>
      </div>
      <div className={styles.composerArea}>
        <Composer sessionId={null} />
      </div>
    </div>
  )
}

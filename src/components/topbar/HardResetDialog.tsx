import { useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { closeHardReset, useUiStore } from '../../app/uiState.js'
import { hardReset, type HardResetFailure } from '../../services/chat/reset.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import styles from './HardResetDialog.module.css'

const FAILURE_KEYS: Record<HardResetFailure, TranslationKey> = {
  backupFailed: 'resetBackupFailed',
  databaseBlocked: 'resetDatabaseBlocked',
  databaseFailed: 'resetDatabaseFailed',
}

/** 硬复位确认：默认勾选导出抢救包与保留本地密钥；失败时留在弹窗内展示原因 */
export const HardResetDialog = () => {
  const t = useTranslate()
  const open = useUiStore((state) => state.hardResetOpen)
  const [exportBackup, setExportBackup] = useState(true)
  const [keepKeys, setKeepKeys] = useState(true)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<HardResetFailure | null>(null)
  if (!open) {
    return null
  }

  const run = async () => {
    if (busy) {
      return
    }
    setBusy(true)
    setFailure(null)
    const result = await hardReset({ exportBackup, keepKeys })
    // 成功路径随后 reload 页面；失败时保持弹窗与选项，便于用户处理后重试
    if (!result.ok) {
      setBusy(false)
      setFailure(result.reason)
    }
  }

  return (
    <Modal
      title={t('hardResetConfirmTitle')}
      closable
      onClose={closeHardReset}
      footer={
        <>
          <Button variant="outlined" onClick={closeHardReset} disabled={busy}>
            {t('cancel')}
          </Button>
          <Button variant="danger" disabled={busy} onClick={() => void run()}>
            {t('hardReset')}
          </Button>
        </>
      }
    >
      <p className={styles.text}>{t('hardResetConfirmText')}</p>
      {failure ? (
        <p className={styles.text} role="alert" style={{ color: 'var(--so-red)' }}>
          {t(FAILURE_KEYS[failure])}
        </p>
      ) : null}
      <label className={styles.option}>
        <input
          type="checkbox"
          checked={exportBackup}
          disabled={busy}
          onChange={(event) => setExportBackup(event.target.checked)}
        />
        <span>{t('exportBeforeReset')}</span>
      </label>
      <label className={styles.option}>
        <input
          type="checkbox"
          checked={keepKeys}
          disabled={busy}
          onChange={(event) => setKeepKeys(event.target.checked)}
        />
        <span>{t('keepLocalKeys')}</span>
      </label>
      <p className={styles.hint}>{t('hardResetHint')}</p>
    </Modal>
  )
}

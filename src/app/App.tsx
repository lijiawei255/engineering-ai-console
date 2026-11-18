import { useEffect, useState, type CSSProperties } from 'react'
import { useTranslate } from '../i18n/index.js'
import { useIsMobile } from './viewport.js'
import { closeMobileSider, useUiStore } from './uiState.js'
import { initChat, useChatStore } from '../services/chat/store.js'
import { ownValue } from '../utils/records.js'
import { useConfigStore } from '../services/config/store.js'
import { Sider } from '../components/sider/Sider.js'
import { SessionView } from '../components/session/SessionView.js'
import { Welcome } from '../components/session/Welcome.js'
import { TopBar } from '../components/topbar/TopBar.js'
import { HardResetDialog } from '../components/topbar/HardResetDialog.js'
import { SettingsDialog } from '../components/settings/SettingsDialog.js'
import { Toast } from '../components/base/Toast.js'
import { Button } from '../components/base/Button.js'
import styles from './App.module.css'

const bannerBase: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '8px 16px',
  borderBottom: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 'calc(12px * var(--console-font-scale))',
  lineHeight: 1.55,
}

const offlineBannerStyle: CSSProperties = {
  ...bannerBase,
  borderBottomColor: 'var(--so-yellow)',
}

const recoveredBannerStyle: CSSProperties = {
  ...bannerBase,
  borderBottomColor: 'var(--so-cyan)',
  color: 'var(--dsw-alias-label-secondary)',
}

const bannerTextStyle: CSSProperties = { flex: 1, minWidth: 0 }

export const App = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const ready = useChatStore((state) => state.ready)
  const initFailure = useChatStore((state) => state.initFailure)
  const activeId = useChatStore((state) => state.activeId)
  const session = useChatStore((state) =>
    state.activeId ? ownValue(state.sessionCache, state.activeId) : undefined
  )
  const resetEpoch = useChatStore((state) => state.resetEpoch)
  const siderCollapsed = useConfigStore((state) => state.settings.ui.siderCollapsed)
  const offline = useConfigStore((state) => state.offline)
  const retryInit = useConfigStore((state) => state.retryInit)
  const storageRecovered = useConfigStore((state) => state.storage.recovered)
  const storageDegraded = useConfigStore((state) => state.storage.degraded)
  const mobileSiderOpen = useUiStore((state) => state.mobileSiderOpen)
  const [retrying, setRetrying] = useState(false)
  const [recoveredDismissed, setRecoveredDismissed] = useState(false)

  useEffect(() => {
    void initChat()
  }, [])

  // 选中会话或切换布局后收起移动端抽屉
  useEffect(() => {
    closeMobileSider()
  }, [activeId, isMobile])

  const retryConnection = () => {
    if (retrying) {
      return
    }
    setRetrying(true)
    void retryInit().finally(() => setRetrying(false))
  }

  return (
    <div className={styles.frame}>
      {offline ? (
        <div role="alert" style={offlineBannerStyle}>
          <span style={bannerTextStyle}>{t('serverOfflineBanner')}</span>
          <Button variant="outlined" size="s" disabled={retrying} onClick={retryConnection}>
            {t('retryConnection')}
          </Button>
        </div>
      ) : null}
      {storageRecovered && !recoveredDismissed ? (
        <div role="status" style={recoveredBannerStyle}>
          <span style={bannerTextStyle}>{t('storageRecovered')}</span>
          <Button variant="outlined" size="s" onClick={() => setRecoveredDismissed(true)}>
            {t('close')}
          </Button>
        </div>
      ) : null}
      {storageDegraded ? (
        <div role="alert" style={offlineBannerStyle}>
          <span style={bannerTextStyle}>{t('storageDegraded')}</span>
        </div>
      ) : null}
      <TopBar />
      <div className={styles.body} key={resetEpoch}>
        {isMobile ? (
          mobileSiderOpen ? (
            <>
              <div className={styles.backdrop} onClick={closeMobileSider} aria-hidden />
              <Sider />
            </>
          ) : null
        ) : siderCollapsed ? null : (
          <Sider />
        )}
        <main className={styles.main}>
          {!ready ? (
            <div className={styles.loading} role="status">
              {t('loading')}
            </div>
          ) : initFailure ? (
            <div className={styles.loading} role="alert">
              {/* 初始化失败发生在浏览器本地会话存储读取阶段，不能误报“保存失败、检查本地服务” */}
              <span>{t('sessionReadFailed')}</span>
              <Button
                variant="outlined"
                size="s"
                onClick={() => {
                  void initChat()
                }}
              >
                {t('retry')}
              </Button>
            </div>
          ) : session ? (
            <SessionView />
          ) : activeId ? (
            <div className={styles.loading} role="status">
              {t('loading')}
            </div>
          ) : (
            <Welcome />
          )}
        </main>
      </div>
      <SettingsDialog />
      <HardResetDialog />
      <Toast />
    </div>
  )
}

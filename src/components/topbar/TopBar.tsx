import { useTranslate } from '../../i18n/index.js'
import { useIsMobile } from '../../app/viewport.js'
import { openHardReset, openSettings, useUiStore } from '../../app/uiState.js'
import { setActiveChannel, setLocale, setUiSettings, useConfigStore } from '../../services/config/store.js'
import type { ChannelSlot, Locale } from '../../services/config/types.js'
import { softReset } from '../../services/chat/store.js'
import { exportChatBackup } from '../../services/chat/reset.js'
import { useTheme } from '../../app/theme.js'
import { IconButton } from '../base/IconButton.js'
import { Menu, type MenuOption } from '../base/Menu.js'
import { Select } from '../base/Select.js'
import { Tooltip } from '../base/Tooltip.js'
import {
  IconDarkOutline16,
  IconDownloadOutline16,
  IconEllipsisOutline16,
  IconLightOutline16,
  IconMenuOutline20,
  IconRefreshOutline16,
  IconSettingsOutline16,
  IconTrashOutline16,
} from '../base/icons.js'
import styles from './TopBar.module.css'

const LANGUAGE_OPTIONS: { value: Locale; label: string; lang: string }[] = [
  { value: 'en', label: 'English', lang: 'en' },
  { value: 'zh', label: '简体中文', lang: 'zh' },
  { value: 'fr', label: 'Français', lang: 'fr' },
  { value: 'ru', label: 'Русский', lang: 'ru' },
]

/** 顶栏常驻：主/备通道、语言、分级复位、主题与设置入口；任何卡死态都可点击 */
export const TopBar = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const theme = useTheme()
  const settings = useConfigStore((state) => state.settings)
  const mode = useConfigStore((state) => state.mode)
  const storage = useConfigStore((state) => state.storage)
  const siderCollapsed = settings.ui.siderCollapsed
  const mobileSiderOpen = useUiStore((state) => state.mobileSiderOpen)
  const toggleMobileSider = useUiStore((state) => state.toggleMobileSider)

  const resetOptions: MenuOption[] = [
    {
      key: 'soft',
      label: t('softReset'),
      icon: <IconRefreshOutline16 />,
      onSelect: softReset,
    },
    {
      key: 'export',
      label: t('exportSessions'),
      icon: <IconDownloadOutline16 />,
      onSelect: () => {
        void exportChatBackup()
      },
    },
    {
      key: 'hard',
      label: t('hardReset'),
      icon: <IconTrashOutline16 />,
      danger: true,
      onSelect: openHardReset,
    },
  ]

  /** 默认主/备名称跟随界面语言；用户改过名称后按原值展示 */
  const channelLabelOf = (slot: ChannelSlot): string => {
    const label = settings.channels[slot].label
    if (slot === 'primary' && label === 'Primary') {
      return t('channelPrimary')
    }
    if (slot === 'backup' && label === 'Backup') {
      return t('channelBackup')
    }
    return label
  }

  const channelButton = (slot: ChannelSlot) => {
    const active = settings.activeChannel === slot
    const label = channelLabelOf(slot)
    return (
      <button
        key={slot}
        type="button"
        className={styles.channelButton}
        aria-pressed={active}
        title={label}
        onClick={() => setActiveChannel(slot)}
      >
        <span className={active ? styles.channelDotActive : styles.channelDot} aria-hidden />
        <span className={styles.channelLabel}>{label}</span>
      </button>
    )
  }

  return (
    <header className={styles.topBar}>
      <div className={styles.left}>
        <IconButton
          size="m"
          tone="primary"
          icon={<IconMenuOutline20 />}
          tooltip={isMobile ? (mobileSiderOpen ? t('collapseSidebar') : t('expandSidebar')) : siderCollapsed ? t('expandSidebar') : t('collapseSidebar')}
          onClick={() => {
            if (isMobile) {
              toggleMobileSider()
            } else {
              setUiSettings({ siderCollapsed: !siderCollapsed })
            }
          }}
        />
        <span className={styles.logo} aria-hidden>
          EA
        </span>
        <span className={styles.brand}>{t('appName')}</span>
      </div>

      <div className={styles.center}>
        <div className={styles.channelSwitch} role="group" aria-label={t('switchChannel')}>
          {channelButton('primary')}
          {channelButton('backup')}
        </div>
        <Tooltip content={t(mode === 'server' ? 'modeServerHint' : 'modeStaticHint')}>
          <span className={styles.modeBadge} data-mode={mode}>
            {t(mode === 'server' ? 'modeServer' : 'modeStatic')}
            {storage.recovered ? <span className={styles.recoveredDot} aria-hidden /> : null}
          </span>
        </Tooltip>
      </div>

      <div className={styles.right}>
        <Select
          value={settings.ui.locale}
          options={LANGUAGE_OPTIONS}
          onChange={(value) => setLocale(value)}
          ariaLabel={t('language')}
          className={styles.languageSelect}
        />
        <IconButton
          size="m"
          tone="primary"
          icon={theme === 'dark' ? <IconLightOutline16 /> : <IconDarkOutline16 />}
          tooltip={theme === 'dark' ? t('themeLight') : t('themeDark')}
          onClick={() =>
            setUiSettings({ themePreference: theme === 'dark' ? 'light' : 'dark' })
          }
        />
        <Menu options={resetOptions}>
          {({ toggle }) => (
            <IconButton
              size="m"
              tone="primary"
              icon={<IconEllipsisOutline16 />}
              tooltip={t('resetMenu')}
              onClick={toggle}
            />
          )}
        </Menu>
        <IconButton
          size="m"
          tone="primary"
          icon={<IconSettingsOutline16 />}
          tooltip={t('settings')}
          onClick={openSettings}
        />
      </div>
    </header>
  )
}

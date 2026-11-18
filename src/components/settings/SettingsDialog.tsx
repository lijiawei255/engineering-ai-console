import { useCallback, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { closeSettings, openHardReset, useUiStore } from '../../app/uiState.js'
import {
  deleteAllSessions,
} from '../../services/chat/store.js'
import { exportChatBackup, exportJsonBackup, importJsonBackup } from '../../services/chat/reset.js'
import { MAX_JSON_BACKUP_BYTES } from '../../services/chat/backup.js'
import {
  clearSecret,
  commitPendingCredentials,
  configSaveFailureKey,
  registerCredentialDraftCommitter,
  setExaConfig,
  setLocale,
  setSecret,
  setUiSettings,
  setWatchdogSettings,
  useConfigStore,
} from '../../services/config/store.js'
import {
  type ContentWidth,
  type FontScale,
  type Locale,
  type ThemePreference,
} from '../../services/config/types.js'
import { showToast } from '../base/toastState.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import { ChannelEditor } from './ChannelEditor.js'
import { PromptEditor } from './PromptEditor.js'
import { Checkbox, Field, InlineStatus, NumberInput, Section, TextInput } from './controls.js'
import styles from './Settings.module.css'

type SettingsTab = 'general' | 'channels' | 'prompts' | 'advanced' | 'data'

const LANGUAGE_OPTIONS: { value: Locale; label: string; lang: string }[] = [
  { value: 'en', label: 'English', lang: 'en' },
  { value: 'zh', label: '简体中文', lang: 'zh' },
  { value: 'fr', label: 'Français', lang: 'fr' },
  { value: 'ru', label: 'Русский', lang: 'ru' },
]

const FONT_OPTIONS: { value: string; label: TranslationKey }[] = [
  { value: '0.9', label: 'fontScale90' },
  { value: '1', label: 'fontScale100' },
  { value: '1.12', label: 'fontScale112' },
  { value: '1.25', label: 'fontScale125' },
]

const ExaEditor = () => {
  const t = useTranslate()
  const exa = useConfigStore((state) => state.settings.exa)
  const secret = useConfigStore((state) => state.secrets.exa)
  const mode = useConfigStore((state) => state.mode)
  const [keyDraft, setKeyDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const keyDraftRef = useRef(keyDraft)
  keyDraftRef.current = keyDraft
  const keySaveRef = useRef<{ value: string; promise: Promise<void> } | null>(null)

  /** 与通道密钥一样：输入框里的草稿在失焦、关闭弹窗或切换标签页前自动提交 */
  const saveKeyDraft = useCallback((): Promise<void> => {
    const value = keyDraftRef.current.trim()
    if (!value) {
      return Promise.resolve()
    }
    const inFlight = keySaveRef.current
    if (inFlight && inFlight.value === value) {
      return inFlight.promise
    }
    const record: { value: string; promise: Promise<void> } = {
      value,
      promise: Promise.resolve(),
    }
    const promise = setSecret('exa', value)
      .then(() => {
        setKeyDraft((current) => (current.trim() === value ? '' : current))
      })
      .finally(() => {
        if (keySaveRef.current === record) {
          keySaveRef.current = null
        }
      })
    record.promise = promise
    keySaveRef.current = record
    return promise
  }, [])

  useEffect(() => {
    const unregister = registerCredentialDraftCommitter(saveKeyDraft)
    return () => {
      unregister()
      void saveKeyDraft().catch(() =>
        showToast({ key: configSaveFailureKey(), type: 'error' })
      )
    }
  }, [saveKeyDraft])

  const apply = async () => {
    if (!keyDraftRef.current.trim() || busy) {
      return
    }
    setBusy(true)
    try {
      await saveKeyDraft()
      showToast({ key: 'saved' })
    } catch {
      showToast({ key: configSaveFailureKey(), type: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.exaEditor}>
      <Field label={t('exaEndpoint')}>
        <TextInput
          mono
          value={exa.endpoint}
          onChange={(value) => setExaConfig({ endpoint: value })}
        />
      </Field>
      <Field label={t('exaKeyEnv')}>
        <TextInput
          mono
          value={exa.apiKeyEnv}
          placeholder="EXA_API_KEY"
          onChange={(value) => setExaConfig({ apiKeyEnv: value })}
        />
      </Field>
      <Field label={t('exaNumResults')}>
        <NumberInput
          value={exa.numResults}
          min={1}
          max={10}
          onChange={(value) => setExaConfig({ numResults: Math.round(value) })}
        />
      </Field>
      <Field label={t('exaKey')} hint={mode === 'static' ? t('apiKeyPlaceholderStatic') : t('apiKeyPlaceholder')}>
        <div className={styles.keyRow}>
          <TextInput
            mono
            type="password"
            value={keyDraft}
            placeholder="exa-…"
            onChange={setKeyDraft}
            onBlur={() => {
              void saveKeyDraft().catch(() =>
                showToast({ key: configSaveFailureKey(), type: 'error' })
              )
            }}
          />
          <Button variant="outlined" size="s" disabled={busy || !keyDraft.trim()} onClick={() => void apply()}>
            {t('save')}
          </Button>
          <Button
            variant="dangerOutlined"
            size="s"
            disabled={busy || (!secret.hasKey && !keyDraft)}
            onClick={() => {
              void clearSecret('exa')
                .then(() => showToast({ key: 'saved' }))
                .catch(() => showToast({ key: configSaveFailureKey(), type: 'error' }))
            }}
          >
            {t('clearKey')}
          </Button>
        </div>
        <div className={styles.keyStatus}>
          {secret.hasKey || secret.envSet ? (
            <span className={styles.keySet}>
              {secret.hasKey ? (
                <>
                  {t('apiKeyMasked')} <code>{secret.mask}</code>
                </>
              ) : (
                <span>{t('configured')}</span>
              )}
            </span>
          ) : (
            <span className={styles.keyMissing}>{t('exaMissingKey')}</span>
          )}
        </div>
      </Field>
    </div>
  )
}

/** 设置弹窗：通用 / 通道 / 提示词 / 高级 / 数据 */
export const SettingsDialog = () => {
  const t = useTranslate()
  const open = useUiStore((state) => state.settingsOpen)
  const settings = useConfigStore((state) => state.settings)
  const storage = useConfigStore((state) => state.storage)
  const mode = useConfigStore((state) => state.mode)
  const saving = useConfigStore((state) => state.saving)
  const saveError = useConfigStore((state) => state.saveError)
  const [tab, setTab] = useState<SettingsTab>('general')
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false)
  const [exportingJson, setExportingJson] = useState(false)
  const [importingJson, setImportingJson] = useState(false)
  const [dataStatus, setDataStatus] = useState<{
    tone: 'info' | 'success' | 'error'
    text: string
  } | null>(null)
  const importInputRef = useRef<HTMLInputElement>(null)

  /** 关闭弹窗前提交密钥 / 自定义 Header 草稿；保存失败时保持弹窗打开，绝不静默丢输入。 */
  const requestClose = () => {
    void (async () => {
      try {
        await commitPendingCredentials()
      } catch {
        showToast({ key: configSaveFailureKey(), type: 'error' })
        return
      }
      closeSettings()
    })()
  }

  /** 切走“通道 / 高级”标签页会卸载对应编辑器：先把草稿保存，再切换。 */
  const switchTab = (next: SettingsTab) => {
    if (next === tab) {
      return
    }
    void commitPendingCredentials()
      .catch(() => showToast({ key: configSaveFailureKey(), type: 'error' }))
      .finally(() => setTab(next))
  }

  if (!open) {
    return null
  }

  const runJsonExport = async () => {
    if (exportingJson) {
      return
    }
    setExportingJson(true)
    setDataStatus(null)
    try {
      if (await exportJsonBackup()) {
        setDataStatus({ tone: 'success', text: t('exportJsonDone') })
      }
    } catch {
      // 导出失败的实际原因是浏览器 IndexedDB 全库读取不完整；提示必须指向本地会话
      // 存储读取失败，而不是误导用户去检查本地 HTTP 服务。
      setDataStatus({ tone: 'error', text: t('sessionReadFailed') })
    } finally {
      setExportingJson(false)
    }
  }

  const runJsonImport = async (file: File) => {
    if (importingJson) {
      return
    }
    // 先按真实文件大小拒绝，避免把超大文件整体读进内存再校验
    if (file.size > MAX_JSON_BACKUP_BYTES) {
      setDataStatus({
        tone: 'error',
        text: t('importJsonTooLarge', { size: MAX_JSON_BACKUP_BYTES / (1024 * 1024) }),
      })
      return
    }
    setImportingJson(true)
    setDataStatus({ tone: 'info', text: t('importJsonBusy') })
    try {
      const raw = await file.text()
      const result = await importJsonBackup(raw)
      if (result.ok) {
        setDataStatus({
          tone: 'success',
          text: t('importJsonDone', { sessions: result.sessions, messages: result.messages }),
        })
      } else if (result.reason === 'invalid') {
        setDataStatus({
          tone: 'error',
          text: t('importJsonInvalid', { message: result.message ?? '' }),
        })
      } else if (result.reason === 'empty') {
        setDataStatus({ tone: 'error', text: t('importJsonEmpty') })
      } else if (result.reason === 'tooLarge') {
        setDataStatus({
          tone: 'error',
          text: t('importJsonTooLarge', { size: MAX_JSON_BACKUP_BYTES / (1024 * 1024) }),
        })
      } else if (result.reason === 'tooMany') {
        setDataStatus({ tone: 'error', text: t('importJsonTooMany') })
      } else {
        setDataStatus({
          tone: 'error',
          text: t('importJsonFailed', { message: result.message ?? '' }),
        })
      }
    } catch (error) {
      setDataStatus({
        tone: 'error',
        text: t('importJsonFailed', {
          message: error instanceof Error ? error.message : String(error),
        }),
      })
    } finally {
      setImportingJson(false)
    }
  }

  const tabs: { id: SettingsTab; label: string }[] = [
    { id: 'general', label: t('general') },
    { id: 'channels', label: t('channels') },
    { id: 'prompts', label: t('prompts') },
    { id: 'advanced', label: t('advanced') },
    { id: 'data', label: t('data') },
  ]

  return (
    <Modal
      title={t('settings')}
      closable
      onClose={requestClose}
      className={styles.dialog}
      mainClassName={styles.main}
    >
      <div className={styles.tabs} role="tablist">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={clsx(styles.tab, tab === item.id && styles.tabActive)}
            onClick={() => switchTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className={styles.tabBody}>
        {saving ? <InlineStatus tone="info">{t('saving')}</InlineStatus> : null}
        {saveError ? <InlineStatus tone="error">{t(configSaveFailureKey())}</InlineStatus> : null}

        {tab === 'general' ? (
          <>
            <Section title={t('general')} hint={t('settingsHint')}>
              <Field label={t('language')}>
                <Select
                  value={settings.ui.locale}
                  options={LANGUAGE_OPTIONS}
                  onChange={(value) => setLocale(value)}
                  ariaLabel={t('language')}
                />
              </Field>
              <Field label={t('theme')}>
                <Select<ThemePreference>
                  value={settings.ui.themePreference}
                  options={[
                    { value: 'light', label: t('themeLight') },
                    { value: 'dark', label: t('themeDark') },
                    { value: 'system', label: t('themeSystem') },
                  ]}
                  onChange={(value) => setUiSettings({ themePreference: value })}
                  ariaLabel={t('theme')}
                />
              </Field>
              <Field label={t('fontSize')}>
                <Select
                  value={String(settings.ui.fontScale)}
                  options={FONT_OPTIONS.map((option) => ({
                    value: option.value,
                    label: t(option.label),
                  }))}
                  onChange={(value) =>
                    setUiSettings({ fontScale: Number(value) as FontScale })
                  }
                  ariaLabel={t('fontSize')}
                />
              </Field>
              <Field label={t('contentWidth')}>
                <Select<ContentWidth>
                  value={settings.ui.contentWidth}
                  options={[
                    { value: 'standard', label: t('widthStandard') },
                    { value: 'wide', label: t('widthWide') },
                  ]}
                  onChange={(value) => setUiSettings({ contentWidth: value })}
                  ariaLabel={t('contentWidth')}
                />
              </Field>
              <Checkbox
                checked={settings.ui.reduceFlicker}
                onChange={(checked) => setUiSettings({ reduceFlicker: checked })}
                label={t('reduceFlicker')}
                hint={t('reduceFlickerHint')}
              />
            </Section>
            <Section title={t(mode === 'server' ? 'modeServer' : 'modeStatic')} hint={t(mode === 'server' ? 'modeServerHint' : 'modeStaticHint')}>
              <div className={styles.storageRow}>
                <span>{t('serverStorageHint')}</span>
                <span className={styles.storageState}>
                  {storage.settings === 'ok'
                    ? t('configured')
                    : storage.settings === 'recovered'
                      ? t('storageRecovered')
                      : t('storageMissing')}
                </span>
              </div>
              {storage.recovered ? <InlineStatus tone="info">{t('storageRecovered')}</InlineStatus> : null}
              {storage.degraded ? (
                <InlineStatus tone="error">{t('storageDegraded')}</InlineStatus>
              ) : null}
            </Section>
          </>
        ) : null}

        {tab === 'channels' ? (
          <>
            <InlineStatus tone="info">{t('apiKeyHint')}</InlineStatus>
            <ChannelEditor slot="primary" />
            <ChannelEditor slot="backup" />
          </>
        ) : null}

        {tab === 'prompts' ? <PromptEditor key={settings.ui.locale} /> : null}

        {tab === 'advanced' ? (
          <>
            <Section title={t('watchdogSection')} hint={t('watchdogHint')}>
              <Field label={t('firstByteTimeout')}>
                <NumberInput
                  value={settings.watchdog.firstByteMs}
                  min={3000}
                  max={600000}
                  step={1000}
                  onChange={(value) => setWatchdogSettings({ firstByteMs: Math.round(value) })}
                />
              </Field>
              <Field label={t('idleTimeout')}>
                <NumberInput
                  value={settings.watchdog.idleMs}
                  min={3000}
                  max={600000}
                  step={1000}
                  onChange={(value) => setWatchdogSettings({ idleMs: Math.round(value) })}
                />
              </Field>
            </Section>
            <Section title={t('webSearchMode')}>
              <ExaEditor />
            </Section>
          </>
        ) : null}

        {tab === 'data' ? (
          <>
            <Section title={t('exportSessions')} hint={t('exportHint')}>
              <div className={styles.buttonRow}>
                <Button variant="outlined" size="s" onClick={() => void exportChatBackup()}>
                  {t('exportSessions')}
                </Button>
              </div>
            </Section>
            <Section title={t('exportSessionsJson')} hint={t('exportJsonHint')}>
              <div className={styles.buttonRow}>
                <Button
                  variant="outlined"
                  size="s"
                  disabled={exportingJson}
                  onClick={() => void runJsonExport()}
                >
                  {t('exportSessionsJson')}
                </Button>
              </div>
            </Section>
            <Section title={t('importSessionsJson')} hint={t('importJsonHint')}>
              <div className={styles.buttonRow}>
                <Button
                  variant="outlined"
                  size="s"
                  disabled={importingJson}
                  onClick={() => importInputRef.current?.click()}
                >
                  {importingJson ? t('importJsonBusy') : t('importSessionsJson')}
                </Button>
                <input
                  ref={importInputRef}
                  type="file"
                  accept="application/json,.json"
                  hidden
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    event.target.value = ''
                    if (file) {
                      void runJsonImport(file)
                    }
                  }}
                />
              </div>
              {dataStatus ? <InlineStatus tone={dataStatus.tone}>{dataStatus.text}</InlineStatus> : null}
            </Section>
            <Section title={t('clearBrowserData')}>
              <div className={styles.buttonRow}>
                <Button variant="dangerOutlined" size="s" onClick={() => setConfirmDeleteAll(true)}>
                  {t('deleteAllChats')}
                </Button>
                <Button variant="dangerOutlined" size="s" onClick={openHardReset}>
                  {t('hardReset')}
                </Button>
              </div>
            </Section>
          </>
        ) : null}
      </div>
      {confirmDeleteAll ? (
        <Modal
          title={t('deleteAllChats')}
          closable
          onClose={() => setConfirmDeleteAll(false)}
          footer={
            <>
              <Button variant="outlined" onClick={() => setConfirmDeleteAll(false)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  void deleteAllSessions()
                  setConfirmDeleteAll(false)
                }}
              >
                {t('delete')}
              </Button>
            </>
          }
        >
          {t('deleteAllChatsConfirm')}
        </Modal>
      ) : null}
    </Modal>
  )
}

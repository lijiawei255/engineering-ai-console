import { useCallback, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import {
  clearSecret,
  configSaveFailureKey,
  ensureConfigSynced,
  patchChannel,
  registerCredentialDraftCommitter,
  setCustomHeaders,
  setSecret,
  useConfigStore,
} from '../../services/config/store.js'
import type { ChannelSlot, HeaderPair, Protocol, ProxyMode } from '../../services/config/types.js'
import {
  countActiveAdvancedOptions,
  thinkingModeForProtocolSwitch,
} from '../../services/config/channelAdvanced.js'
import { normalizeChatUrl, type UrlError } from '../../services/api/url.js'
import { pingChannel, probeModels, type PingResult } from '../../services/api/probe.js'
import { anthropicThinkingTokens } from '../../services/api/serialize.js'
import { showToast } from '../base/toastState.js'
import { Button } from '../base/Button.js'
import { Select } from '../base/Select.js'
import {
  Checkbox,
  Field,
  InlineStatus,
  NumberInput,
  Section,
  TextInput,
} from './controls.js'
import styles from './Settings.module.css'

const URL_ERROR_KEY: Record<UrlError, TranslationKey> = {
  emptyUrl: 'urlErrorEmpty',
  invalidUrl: 'urlErrorInvalid',
  invalidProtocol: 'urlErrorProtocol',
  baseUrlHasQuery: 'urlErrorQuery',
}

const PROTOCOLS: { value: Protocol; label: TranslationKey }[] = [
  { value: 'openai', label: 'protocolOpenAi' },
  { value: 'anthropic', label: 'protocolAnthropic' },
]

/**
 * 单条通道的配置编辑器。
 *
 * 首屏只保留四项必填配置：协议、接口地址、API Key、模型；其余面向特殊网关微调的
 * 选项全部收进默认折叠的“高级设置”，并用标题旁的计数徽章提示有多少项正在生效。
 * 所有字段即时生效；密钥在失焦、探测或关闭弹窗时自动落盘，不需要单独的保存按钮。
 */
export const ChannelEditor = ({ slot }: { slot: ChannelSlot }) => {
  const t = useTranslate()
  const channel = useConfigStore((state) => state.settings.channels[slot])
  const secret = useConfigStore((state) => state.secrets[slot])
  const headerMasks = useConfigStore((state) => state.secrets.customHeaders[slot])
  const mode = useConfigStore((state) => state.mode)
  const [keyDraft, setKeyDraft] = useState('')
  const [keyBusy, setKeyBusy] = useState(false)
  const [pinging, setPinging] = useState(false)
  const [pingResult, setPingResult] = useState<PingResult | null>(null)
  const [probing, setProbing] = useState(false)
  const [probeModelsList, setProbeModelsList] = useState<string[] | null>(null)
  const [probeMessage, setProbeMessage] = useState<string | null>(null)
  /** 服务端模式：Header 新值只保存在本地编辑态，显式保存后才提交 */
  const [headerValueDrafts, setHeaderValueDrafts] = useState<Record<number, string>>({})
  const [headersBusy, setHeadersBusy] = useState(false)
  /**
   * 只存在于组件本地的尾部空白编辑行。
   *
   * 点击 Add header 新增的行还没有 name，若照常写进 store，350ms 防抖保存后服务端会
   * 按规则过滤掉空名称行并回写快照，用户正准备输入的空行会在约 0.4 秒后自行消失。
   * 因此 name 为空的行只留在本地草稿里，等用户填好名称后才并入通道配置。
   */
  const [pendingHeaders, setPendingHeaders] = useState<HeaderPair[]>([])

  // 自动提交需要读取“最新一帧”的输入与通道，不能依赖事件闭包里的旧值
  const channelRef = useRef(channel)
  channelRef.current = channel
  const keyDraftRef = useRef(keyDraft)
  keyDraftRef.current = keyDraft
  const headerDraftsRef = useRef(headerValueDrafts)
  headerDraftsRef.current = headerValueDrafts
  const pendingHeadersRef = useRef(pendingHeaders)
  pendingHeadersRef.current = pendingHeaders
  const keySaveRef = useRef<{ value: string; promise: Promise<void> } | null>(null)

  // 切到另一个通道槽位时，上一条通道的本地草稿不能串到这一条。
  useEffect(() => {
    setPendingHeaders([])
    setHeaderValueDrafts({})
  }, [slot])

  const patch = (value: Parameters<typeof patchChannel>[1]) => patchChannel(slot, value)
  const url = normalizeChatUrl(channel)

  /** 默认主/备名称按界面语言展示；用户自定义后显示原值 */
  const sectionTitle =
    channel.label === (slot === 'primary' ? 'Primary' : 'Backup')
      ? t(slot === 'primary' ? 'channelPrimary' : 'channelBackup')
      : channel.label

  const advancedCount = countActiveAdvancedOptions(channel, slot)
  const thinkingTokens =
    channel.thinkingParamMode === 'anthropic_thinking'
      ? anthropicThinkingTokens(channel)
      : null

  /** 切换协议：只有未被手动改过的思考策略才跟随新协议的默认值 */
  const chooseProtocol = (protocol: Protocol) => {
    if (protocol === channel.protocol) {
      return
    }
    patch({
      protocol,
      thinkingParamMode: thinkingModeForProtocolSwitch(channel, protocol),
    })
  }

  const maskOfHeader = (name: string): string =>
    headerMasks.find((item) => item.name === name)?.mask ?? ''

  /**
   * 把本地草稿里已经填好名称的行并入通道配置。
   *
   * 只有名称非空才写 store：空名称行继续留在本地，避免服务端过滤空行的快照把用户正在
   * 准备输入的行冲掉。名称失焦、探测前、关窗兜底都走这里，保证填好的名称不丢。
   */
  const absorbPendingHeaders = useCallback((): void => {
    const named: HeaderPair[] = []
    for (const row of pendingHeadersRef.current) {
      const name = row.name.trim()
      if (name) {
        named.push({ name, value: row.value })
      }
    }
    if (named.length === 0) {
      return
    }
    setPendingHeaders((current) => current.filter((row) => !row.name.trim()))
    const state = useConfigStore.getState()
    const current = state.settings.channels[slot]
    const offset = current.customHeaders.length
    const staticMode = state.mode === 'static'
    patchChannel(slot, {
      customHeaders: [
        ...current.customHeaders,
        ...named.map((row) => ({ name: row.name, value: staticMode ? row.value : '' })),
      ],
    })
    if (!staticMode) {
      // 值草稿按渲染后的行下标登记；尾部草稿只追加在已有行之后，旧下标不受影响
      const merged = { ...headerDraftsRef.current }
      named.forEach((row, index) => {
        if (row.value.trim()) {
          merged[offset + index] = row.value
        }
      })
      headerDraftsRef.current = merged
      setHeaderValueDrafts(merged)
    }
  }, [slot])

  /**
   * 提交自定义请求头的值草稿（仅服务端模式）。
   *
   * Save 按钮显式点击时提示“已保存”并强制提交；名称失焦、探测前与关窗时只静默提交
   * 确实填了值的项。归一化与空值过滤逻辑只保留这一份。
   */
  const commitHeaderDrafts = useCallback(
    async (notify: boolean, force = false): Promise<void> => {
      const state = useConfigStore.getState()
      if (state.mode !== 'server') {
        return
      }
      const drafts = headerDraftsRef.current
      const pairs = state.settings.channels[slot].customHeaders
        .map((header, index) => ({
          name: header.name.trim(),
          value: (drafts[index] ?? '').trim(),
        }))
        .filter((pair) => pair.name.length > 0)
      if (!force && !pairs.some((pair) => pair.value.length > 0)) {
        return
      }
      await ensureConfigSynced()
      await setCustomHeaders(slot, pairs)
      setHeaderValueDrafts({})
      if (notify) {
        showToast({ key: 'saved' })
      }
    },
    [slot]
  )

  const saveHeaders = async () => {
    if (headersBusy) {
      return
    }
    setHeadersBusy(true)
    try {
      absorbPendingHeaders()
      await commitHeaderDrafts(true, true)
    } catch {
      showToast({ key: configSaveFailureKey(), type: 'error' })
    } finally {
      setHeadersBusy(false)
    }
  }

  const removeHeader = (index: number) => {
    const next = channel.customHeaders.filter((_, headerIndex) => headerIndex !== index)
    patch({ customHeaders: next })
    setHeaderValueDrafts({})
    if (mode === 'server') {
      // 不在列表中的同名 Header 会被服务端删除，这里同步清理 secrets
      void setCustomHeaders(
        slot,
        next.map((header) => ({ name: header.name, value: '' }))
      ).catch(() => showToast({ key: configSaveFailureKey(), type: 'error' }))
    }
  }

  /**
   * 提交密钥输入框里的草稿。并发调用（失焦 + 探测 + 关窗）复用同一个请求，
   * 成功后只在输入框仍是该值时清空，避免覆盖用户刚输入的新值。
   */
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
    const promise = setSecret(slot, value)
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
  }, [slot])

  // 关闭设置弹窗或切到别的标签页时组件会先卸载：注册的提交点保证草稿不丢。
  useEffect(() => {
    const commit = async () => {
      absorbPendingHeaders()
      await saveKeyDraft()
      await commitHeaderDrafts(false)
    }
    const unregister = registerCredentialDraftCommitter(commit)
    return () => {
      unregister()
      void commit().catch(() => showToast({ key: configSaveFailureKey(), type: 'error' }))
    }
  }, [absorbPendingHeaders, commitHeaderDrafts, saveKeyDraft])

  const clearStoredKey = async () => {
    setKeyBusy(true)
    try {
      await clearSecret(slot)
      setKeyDraft('')
      showToast({ key: 'saved' })
    } catch {
      showToast({ key: configSaveFailureKey(), type: 'error' })
    } finally {
      setKeyBusy(false)
    }
  }

  const commitDraftsBeforeProbe = async (): Promise<string | undefined> => {
    // 先把输入框里未提交的密钥 / Header 落盘，再探测：探测和对话必须用同一份凭据
    try {
      absorbPendingHeaders()
      await saveKeyDraft()
      await commitHeaderDrafts(false)
      return undefined
    } catch {
      // 保存失败不掩盖探测结论：仍用草稿密钥探活，同时明确提示这次没存上
      showToast({ key: configSaveFailureKey(), type: 'error' })
      return keyDraftRef.current.trim() || undefined
    }
  }

  const runPing = async () => {
    setPinging(true)
    setPingResult(null)
    try {
      const draftKey = await commitDraftsBeforeProbe()
      const result = await pingChannel({
        slot,
        channel: channelRef.current,
        draftKey,
      })
      setPingResult(result)
    } finally {
      setPinging(false)
    }
  }

  const runProbe = async () => {
    setProbing(true)
    setProbeMessage(null)
    setProbeModelsList(null)
    try {
      const draftKey = await commitDraftsBeforeProbe()
      const result = await probeModels({
        slot,
        channel: channelRef.current,
        draftKey,
      })
      setProbeModelsList(result.models)
      setProbeMessage(
        result.models.length > 0
          ? t('modelsReceived', { count: result.models.length })
          : t('modelsEmpty')
      )
    } finally {
      setProbing(false)
    }
  }

  /** 名称一栏：已有行照旧写配置；本地草稿行只有填好名称（失焦）后才并入配置。 */
  const updateHeaderName = (index: number, value: string) => {
    if (index < channel.customHeaders.length) {
      patch({
        customHeaders: channel.customHeaders.map((header, headerIndex) =>
          headerIndex === index ? { ...header, name: value } : header
        ),
      })
      return
    }
    const pendingIndex = index - channel.customHeaders.length
    setPendingHeaders((rows) =>
      rows.map((row, rowIndex) => (rowIndex === pendingIndex ? { ...row, name: value } : row))
    )
  }

  /** 值一栏：服务端模式的值只进本地草稿，静态模式随设置直接落盘。 */
  const updateHeaderValue = (index: number, value: string) => {
    const persistedCount = channel.customHeaders.length
    if (index >= persistedCount) {
      const pendingIndex = index - persistedCount
      setPendingHeaders((rows) =>
        rows.map((row, rowIndex) => (rowIndex === pendingIndex ? { ...row, value } : row))
      )
      return
    }
    if (mode === 'server') {
      setHeaderValueDrafts((current) => ({ ...current, [index]: value }))
      return
    }
    patch({
      customHeaders: channel.customHeaders.map((header, headerIndex) =>
        headerIndex === index ? { ...header, value } : header
      ),
    })
  }

  const removeHeaderRow = (index: number) => {
    const persistedCount = channel.customHeaders.length
    if (index >= persistedCount) {
      const pendingIndex = index - persistedCount
      setPendingHeaders((rows) => rows.filter((_, rowIndex) => rowIndex !== pendingIndex))
      return
    }
    removeHeader(index)
  }

  return (
    <div className={styles.channelEditor}>
      <Section title={sectionTitle}>
        <Field label={t('protocol')}>
          <div className={styles.segmented} role="group" aria-label={t('protocol')}>
            {PROTOCOLS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={clsx(
                  styles.segment,
                  channel.protocol === option.value && styles.segmentActive
                )}
                aria-pressed={channel.protocol === option.value}
                onClick={() => chooseProtocol(option.value)}
              >
                {t(option.label)}
              </button>
            ))}
          </div>
        </Field>

        <Field
          label={t('baseUrl')}
          hint={channel.lockRawUrl ? t('urlLockedHint') : undefined}
        >
          <TextInput
            mono
            value={channel.baseUrl}
            placeholder={t('baseUrlPlaceholder')}
            onChange={(value) => patch({ baseUrl: value })}
          />
          <div className={styles.urlPreview} aria-live="polite">
            <span className={styles.urlPreviewArrow} aria-hidden="true">
              →
            </span>
            {url.ok ? (
              <code className={styles.urlPreviewValue}>{url.url}</code>
            ) : (
              <span className={styles.urlPreviewEmpty}>
                {channel.baseUrl.trim() ? t(URL_ERROR_KEY[url.error]) : t('urlPreviewEmpty')}
              </span>
            )}
          </div>
        </Field>

        <Field
          label={t('apiKey')}
          hint={mode === 'static' ? t('apiKeyPlaceholderStatic') : t('apiKeyPlaceholder')}
        >
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
              <span className={styles.keyMissing}>{t('notConfigured')}</span>
            )}
          </div>
          <div className={styles.keyRow}>
            <TextInput
              mono
              type="password"
              value={keyDraft}
              placeholder="your-api-key"
              onChange={setKeyDraft}
              onBlur={() => {
                void saveKeyDraft().catch(() =>
                  showToast({ key: configSaveFailureKey(), type: 'error' })
                )
              }}
            />
            <Button
              variant="dangerOutlined"
              size="s"
              disabled={keyBusy || (!secret.hasKey && !keyDraft.trim())}
              onClick={() => void clearStoredKey()}
            >
              {t('clearKey')}
            </Button>
          </div>
          <div className={styles.fieldHint}>{t('apiKeyAutoSaveHint')}</div>
        </Field>

        <Field label={t('model')}>
          <div className={styles.modelRow}>
            <TextInput
              mono
              value={channel.model}
              placeholder={t('modelPlaceholder')}
              onChange={(value) => patch({ model: value })}
            />
            <Button variant="outlined" size="s" disabled={probing} onClick={() => void runProbe()}>
              {probing ? t('probing') : t('probeModels')}
            </Button>
          </div>
        </Field>
        {probeMessage ? <InlineStatus tone="info">{probeMessage}</InlineStatus> : null}
        {probeModelsList && probeModelsList.length > 0 ? (
          <div className={styles.modelList}>
            {probeModelsList.map((model) => (
              <button
                key={model}
                type="button"
                className={styles.modelChip}
                aria-pressed={channel.model === model}
                onClick={() => patch({ model })}
              >
                {model}
              </button>
            ))}
          </div>
        ) : null}
        <div className={styles.pingRow}>
          <Button variant="outlined" size="s" disabled={pinging} onClick={() => void runPing()}>
            {pinging ? t('pinging') : t('ping')}
          </Button>
          {pingResult ? (
            <InlineStatus tone={pingResult.reachable ? 'success' : 'error'}>
              {pingResult.reachable
                ? pingResult.modelsAvailable
                  ? t('pingOk')
                  : t('pingOkNoModels')
                : t('pingFail', { message: pingResult.message ?? '' })}
            </InlineStatus>
          ) : null}
        </div>
      </Section>

      <details className={styles.advanced}>
        <summary className={styles.advancedSummary}>
          <span>{t('advancedSettings')}</span>
          {advancedCount > 0 ? (
            <span
              className={styles.advancedBadge}
              aria-label={t('advancedActiveCount', { count: advancedCount })}
            >
              ({advancedCount})
            </span>
          ) : null}
        </summary>
        <div className={styles.advancedBody}>
          <Field label={t('channelLabel')}>
            <TextInput value={channel.label} onChange={(value) => patch({ label: value })} />
          </Field>

          <Checkbox
            checked={channel.lockRawUrl}
            onChange={(checked) => patch({ lockRawUrl: checked })}
            label={t('lockRawUrl')}
            hint={t('lockRawUrlHint')}
          />

          <Field label={t('thinkingModel')} hint={t('thinkingModelHint')}>
            <TextInput
              mono
              value={channel.thinkingModel}
              placeholder={t('modelPlaceholder')}
              onChange={(value) => patch({ thinkingModel: value })}
            />
          </Field>
          <Field label={t('thinkingParamMode')}>
            <Select
              value={channel.thinkingParamMode}
              options={[
                { value: 'none', label: t('thinkingParamNone') },
                { value: 'anthropic_thinking', label: t('thinkingParamAnthropic') },
                { value: 'deepseek_thinking', label: t('thinkingParamDeepseek') },
                { value: 'openai_reasoning_effort', label: t('thinkingParamReasoning') },
                { value: 'enable_thinking', label: t('thinkingParamEnable') },
              ]}
              onChange={(value) => patch({ thinkingParamMode: value })}
              ariaLabel={t('thinkingParamMode')}
            />
          </Field>
          {thinkingTokens ? (
            <InlineStatus tone="info">
              {t('thinkingBudgetHint', {
                budget: thinkingTokens.budgetTokens,
                maxTokens: thinkingTokens.maxTokens,
              })}
            </InlineStatus>
          ) : null}

          <Field label={t('apiKeyEnv')}>
            <TextInput
              mono
              value={channel.apiKeyEnv}
              placeholder="API_KEY"
              onChange={(value) => patch({ apiKeyEnv: value })}
            />
          </Field>

          <Field
            label={t('customHeaders')}
            hint={mode === 'server' ? t('customHeadersMaskedHint') : undefined}
          >
            <div className={styles.headerList}>
              {[...channel.customHeaders, ...pendingHeaders].map((header, index) => {
                const persisted = index < channel.customHeaders.length
                return (
                  <div
                    key={persisted ? `saved-${index}` : `draft-${index - channel.customHeaders.length}`}
                    className={styles.headerRow}
                  >
                    <TextInput
                      mono
                      value={header.name}
                      placeholder={t('headerName')}
                      onChange={(value) => updateHeaderName(index, value)}
                      onBlur={() => {
                        if (!persisted) {
                          absorbPendingHeaders()
                        }
                      }}
                    />
                    {mode === 'server' ? (
                      <TextInput
                        mono
                        type="password"
                        value={persisted ? (headerValueDrafts[index] ?? '') : header.value}
                        placeholder={maskOfHeader(header.name) || t('headerValue')}
                        onChange={(value) => updateHeaderValue(index, value)}
                        onBlur={() => {
                          void commitHeaderDrafts(false).catch(() =>
                            showToast({ key: configSaveFailureKey(), type: 'error' })
                          )
                        }}
                      />
                    ) : (
                      <TextInput
                        mono
                        value={header.value}
                        placeholder={t('headerValue')}
                        onChange={(value) => updateHeaderValue(index, value)}
                      />
                    )}
                    <Button variant="outlined" size="s" onClick={() => removeHeaderRow(index)}>
                      {t('remove')}
                    </Button>
                  </div>
                )
              })}
              <div className={styles.buttonRow}>
                <Button
                  variant="outlined"
                  size="s"
                  onClick={() => setPendingHeaders((rows) => [...rows, { name: '', value: '' }])}
                >
                  {t('addHeader')}
                </Button>
                {mode === 'server' ? (
                  <Button
                    variant="outlined"
                    size="s"
                    disabled={headersBusy}
                    onClick={() => void saveHeaders()}
                  >
                    {t('save')}
                  </Button>
                ) : null}
              </div>
            </div>
          </Field>

          <Field label={t('requestTimeout')}>
            <NumberInput
              value={channel.requestTimeoutSec}
              min={5}
              max={600}
              suffix="s"
              onChange={(value) => patch({ requestTimeoutSec: Math.round(value) })}
            />
          </Field>

          <Checkbox
            checked={channel.enableRemoteFileApi}
            onChange={(checked) => patch({ enableRemoteFileApi: checked })}
            label={t('remoteFileApi')}
            hint={t('remoteFileApiHint')}
          />

          <Field label={t('modalityMode')}>
            <Select
              value={channel.modalityMode}
              options={[
                { value: 'auto', label: t('modalityAuto') },
                { value: 'text_only', label: t('modalityTextOnly') },
                { value: 'multimodal', label: t('modalityMultimodal') },
              ]}
              onChange={(value) => patch({ modalityMode: value })}
              ariaLabel={t('modalityMode')}
            />
          </Field>
          <Field label={t('webSearchMode')}>
            <Select
              value={channel.webSearchMode}
              options={[
                { value: 'off', label: t('webSearchOff') },
                { value: 'exa', label: t('webSearchExa') },
                { value: 'native', label: t('webSearchNative') },
              ]}
              onChange={(value) => patch({ webSearchMode: value })}
              ariaLabel={t('webSearchMode')}
            />
          </Field>

          <Field label={t('proxyMode')}>
            <Select<ProxyMode>
              value={channel.proxyMode}
              options={[
                { value: 'system', label: t('proxySystem') },
                { value: 'direct', label: t('proxyDirect') },
                { value: 'custom', label: t('proxyCustom') },
              ]}
              onChange={(value) => patch({ proxyMode: value })}
              ariaLabel={t('proxyMode')}
            />
          </Field>
          {channel.proxyMode === 'custom' ? (
            <Field label={t('proxyUrl')}>
              <TextInput
                mono
                value={channel.proxyUrl}
                placeholder="http://127.0.0.1:7890"
                onChange={(value) => patch({ proxyUrl: value })}
              />
            </Field>
          ) : null}
          <Checkbox
            checked={channel.allowInsecureTls}
            onChange={(checked) => patch({ allowInsecureTls: checked })}
            label={t('allowInsecureTls')}
          />

          <Field label={t('temperature')}>
            <div className={styles.optionRow}>
              <Checkbox
                checked={channel.temperatureEnabled}
                onChange={(checked) => patch({ temperatureEnabled: checked })}
                label={t('temperature')}
              />
              <NumberInput
                value={channel.temperature}
                min={0}
                max={2}
                step={0.1}
                disabled={!channel.temperatureEnabled}
                onChange={(value) => patch({ temperature: value })}
              />
            </div>
          </Field>
          <Field label={t('maxTokens')}>
            <div className={styles.optionRow}>
              <Checkbox
                checked={channel.maxTokensEnabled}
                onChange={(checked) => patch({ maxTokensEnabled: checked })}
                label={t('maxTokens')}
              />
              <NumberInput
                value={channel.maxTokens}
                min={1}
                max={2_000_000}
                disabled={!channel.maxTokensEnabled}
                onChange={(value) => patch({ maxTokens: Math.round(value) })}
              />
            </div>
          </Field>
        </div>
      </details>
    </div>
  )
}

import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  configSaveFailureKey,
  patchPrompts,
  setCapsuleTemplate,
  setSystemPrompt,
  useConfigStore,
} from '../../services/config/store.js'
import type { CapsuleId } from '../../services/config/types.js'
import {
  CAPSULE_IDS,
  LANGUAGE_LABELS,
  getDefaultCapsuleTemplate,
  getDefaultSystemPrompt,
  getEditableCapsuleTemplate,
  isDefaultCapsuleTemplate,
  isDefaultSystemPrompt,
  resolveSystemPrompt,
} from '../../prompts/defaults.js'
import { showToast } from '../base/toastState.js'
import { Button } from '../base/Button.js'
import { Select } from '../base/Select.js'
import { Field, InlineStatus, Section } from './controls.js'
import styles from './Settings.module.css'

const CAPSULE_KEYS: Record<CapsuleId, { label: 'capsuleAgent2' | 'capsuleAgent3' | 'capsuleDistill'; desc: 'capsuleAgent2Desc' | 'capsuleAgent3Desc' | 'capsuleDistillDesc' }> = {
  agent2: { label: 'capsuleAgent2', desc: 'capsuleAgent2Desc' },
  agent3: { label: 'capsuleAgent3', desc: 'capsuleAgent3Desc' },
  distill: { label: 'capsuleDistill', desc: 'capsuleDistillDesc' },
}

/** 提示词编辑：系统人格 + 三个动作胶囊模板，单项恢复默认 */
export const PromptEditor = () => {
  const t = useTranslate()
  const locale = useConfigStore((state) => state.settings.ui.locale)
  const prompts = useConfigStore((state) => state.settings.prompts)
  const [systemValue, setSystemValue] = useState(() => resolveSystemPrompt(locale, prompts))
  const [capsuleValues, setCapsuleValues] = useState<Record<CapsuleId, string>>(() => ({
    agent2: getEditableCapsuleTemplate(locale, 'agent2', prompts),
    agent3: getEditableCapsuleTemplate(locale, 'agent3', prompts),
    distill: getEditableCapsuleTemplate(locale, 'distill', prompts),
  }))

  const resetSystem = () => {
    try {
      if (!setSystemPrompt(locale, '')) {
        // 纯静态模式写本地存储失败：配置层已弹出准确的本地存储失败提示，绝不显示 Saved
        return
      }
      setSystemValue(getDefaultSystemPrompt(locale))
      showToast({ key: 'saved' })
    } catch {
      showToast({ key: configSaveFailureKey(), type: 'error' })
    }
  }

  const resetCapsule = (id: CapsuleId) => {
    try {
      if (!setCapsuleTemplate(locale, id, '')) {
        return
      }
      setCapsuleValues((current) => ({
        ...current,
        [id]: getDefaultCapsuleTemplate(locale, id),
      }))
      showToast({ key: 'saved' })
    } catch {
      showToast({ key: configSaveFailureKey(), type: 'error' })
    }
  }

  const saveAll = () => {
    try {
      let applied = setSystemPrompt(locale, systemValue)
      for (const id of CAPSULE_IDS) {
        // 先全部尝试写入：任一项落盘失败时不显示 Saved，失败提示由配置层统一弹出
        applied = setCapsuleTemplate(locale, id, capsuleValues[id]) && applied
      }
      if (!applied) {
        return
      }
      showToast({ key: 'saved' })
    } catch {
      // 绝不把 file:// 下的本地存储失败误导成“检查本地服务”
      showToast({ key: configSaveFailureKey(), type: 'error' })
    }
  }

  const allDefault =
    isDefaultSystemPrompt(locale, prompts) &&
    CAPSULE_IDS.every((id) => isDefaultCapsuleTemplate(locale, id, prompts))

  return (
    <div className={styles.promptEditor}>
      <Section title={t('systemPrompt')} hint={t('systemPromptHint')}>
        <textarea
          className={styles.promptTextarea}
          value={systemValue}
          rows={14}
          onChange={(event) => setSystemValue(event.target.value)}
          spellCheck={false}
        />
        <div className={styles.buttonRow}>
          <Button variant="outlined" size="s" onClick={resetSystem}>
            {t('resetDefault')}
          </Button>
          {locale === 'fr' || locale === 'ru' ? (
            <InlineStatus tone="info">{t('promptLanguageFallback')}</InlineStatus>
          ) : null}
        </div>
      </Section>

      <Section title={t('downstreamLanguage')} hint={t('downstreamLanguageHint')}>
        <Field label={t('downstreamLanguage')}>
          <Select
            value={prompts.downstreamLanguage}
            options={[
              { value: 'follow', label: t('languageFollow') },
              { value: 'en', label: LANGUAGE_LABELS.en, lang: 'en' },
              { value: 'zh', label: LANGUAGE_LABELS.zh, lang: 'zh' },
              { value: 'fr', label: LANGUAGE_LABELS.fr, lang: 'fr' },
              { value: 'ru', label: LANGUAGE_LABELS.ru, lang: 'ru' },
            ]}
            onChange={(value) => patchPrompts({ downstreamLanguage: value })}
            ariaLabel={t('downstreamLanguage')}
          />
        </Field>
      </Section>

      <Section title={t('capsuleTemplates')} hint={t('capsuleTemplatesHint')}>
        <p className={styles.sectionHint}>{t('capsuleTemplateRawHint')}</p>
        {CAPSULE_IDS.map((id) => (
          <div key={id} className={styles.capsuleEditor}>
            <div className={styles.capsuleEditorHeader}>
              <div>
                <div className={styles.capsuleEditorTitle}>{t(CAPSULE_KEYS[id].label)}</div>
                <div className={styles.capsuleEditorHint}>{t(CAPSULE_KEYS[id].desc)}</div>
              </div>
              <Button variant="outlined" size="s" onClick={() => resetCapsule(id)}>
                {t('resetDefault')}
              </Button>
            </div>
            <textarea
              className={styles.promptTextarea}
              value={capsuleValues[id]}
              rows={7}
              onChange={(event) =>
                setCapsuleValues((current) => ({ ...current, [id]: event.target.value }))
              }
              spellCheck={false}
            />
          </div>
        ))}
        <div className={styles.buttonRow}>
          <Button variant="primary" size="s" onClick={saveAll}>
            {t('save')}
          </Button>
          {allDefault ? <InlineStatus tone="info">{t('savedDefault')}</InlineStatus> : null}
        </div>
      </Section>
    </div>
  )
}

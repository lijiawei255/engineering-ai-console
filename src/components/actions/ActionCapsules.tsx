import clsx from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import type { CapsuleId } from '../../services/config/types.js'
import { setPendingCapsule, useChatStore } from '../../services/chat/store.js'
import {
  IconDataOutline16,
  IconSearchOutline16,
  IconSendOutline16,
} from '../base/icons.js'
import styles from './ActionCapsules.module.css'

const CAPSULES: { id: CapsuleId; labelKey: 'capsuleAgent2' | 'capsuleAgent3' | 'capsuleDistill'; descKey: 'capsuleAgent2Desc' | 'capsuleAgent3Desc' | 'capsuleDistillDesc'; Icon: typeof IconSendOutline16 }[] = [
  { id: 'agent2', labelKey: 'capsuleAgent2', descKey: 'capsuleAgent2Desc', Icon: IconSendOutline16 },
  { id: 'agent3', labelKey: 'capsuleAgent3', descKey: 'capsuleAgent3Desc', Icon: IconSearchOutline16 },
  { id: 'distill', labelKey: 'capsuleDistill', descKey: 'capsuleDistillDesc', Icon: IconDataOutline16 },
]

/**
 * 单次触发式动作胶囊：默认无选中；点击仅对下一条消息生效，发送后自动恢复默认。
 * 指令模板只在请求末尾注入，绝不改 system 字段（保护前缀 KV Cache）。
 */
export const ActionCapsules = () => {
  const t = useTranslate()
  const pending = useChatStore((state) => state.pendingCapsule)
  return (
    <div className={styles.bar} role="group" aria-label={t('capsuleBarLabel')}>
      {CAPSULES.map(({ id, labelKey, descKey, Icon }) => {
        const selected = pending === id
        return (
          <button
            key={id}
            type="button"
            className={clsx(styles.capsule, selected && styles.selected)}
            aria-pressed={selected}
            title={t(descKey)}
            onClick={() => setPendingCapsule(selected ? null : id)}
          >
            <Icon />
            <span className={styles.label}>{t(labelKey)}</span>
          </button>
        )
      })}
      {pending ? (
        <span className={styles.activeHint} role="status">
          {t('capsuleActive')}
        </span>
      ) : null}
    </div>
  )
}

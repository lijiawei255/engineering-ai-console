import type { ReactNode } from 'react'
import clsx from 'clsx'
import styles from './Settings.module.css'

export const Section = ({
  title,
  hint,
  children,
}: {
  title: string
  hint?: string
  children: ReactNode
}) => (
  <section className={styles.section}>
    <h3 className={styles.sectionTitle}>{title}</h3>
    {hint ? <p className={styles.sectionHint}>{hint}</p> : null}
    <div className={styles.sectionBody}>{children}</div>
  </section>
)

export const Field = ({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) => (
  <div className={styles.field}>
    <div className={styles.fieldLabel}>{label}</div>
    <div className={styles.fieldControl}>{children}</div>
    {hint ? <div className={styles.fieldHint}>{hint}</div> : null}
  </div>
)

export const TextInput = ({
  value,
  onChange,
  placeholder,
  type = 'text',
  mono = false,
  disabled = false,
  onBlur,
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  type?: 'text' | 'password'
  mono?: boolean
  disabled?: boolean
  /** 输入框失焦时提交草稿（密钥 / 自定义请求头值），避免“填了但没点保存” */
  onBlur?: () => void
}) => (
  <input
    className={clsx(styles.input, mono && styles.mono)}
    value={value}
    type={type}
    placeholder={placeholder}
    disabled={disabled}
    onChange={(event) => onChange(event.target.value)}
    onBlur={onBlur}
    spellCheck={false}
  />
)

export const NumberInput = ({
  value,
  onChange,
  min,
  max,
  step = 1,
  disabled = false,
  suffix,
}: {
  value: number
  onChange: (value: number) => void
  min: number
  max: number
  step?: number
  disabled?: boolean
  suffix?: string
}) => (
  <span className={styles.numberWrap}>
    <input
      className={clsx(styles.input, styles.number)}
      type="number"
      value={Number.isFinite(value) ? value : min}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onChange={(event) => {
        const next = Number(event.target.value)
        if (Number.isFinite(next)) {
          onChange(Math.min(max, Math.max(min, next)))
        }
      }}
    />
    {suffix ? <span className={styles.suffix}>{suffix}</span> : null}
  </span>
)

export const Checkbox = ({
  checked,
  onChange,
  label,
  hint,
  disabled = false,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  hint?: string
  disabled?: boolean
}) => (
  <label className={clsx(styles.checkbox, disabled && styles.disabled)}>
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
    />
    <span className={styles.checkboxText}>
      <span className={styles.checkboxLabel}>{label}</span>
      {hint ? <span className={styles.checkboxHint}>{hint}</span> : null}
    </span>
  </label>
)

export const InlineStatus = ({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'error' | 'success'
  children: ReactNode
}) => <div className={clsx(styles.status, styles[tone])}>{children}</div>

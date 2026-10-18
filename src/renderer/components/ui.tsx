import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

/* ------------------------------------------------------------------ */
/* Button                                                              */
/* ------------------------------------------------------------------ */

export type ButtonKind = 'default' | 'primary' | 'danger' | 'ghost'

export function Button({
  kind = 'default',
  size,
  icon,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  kind?: ButtonKind
  size?: 'sm'
  icon?: boolean
}): React.ReactElement {
  const cls = ['btn', kind !== 'default' ? kind : '', size === 'sm' ? 'sm' : '', icon ? 'icon' : '']
    .filter(Boolean)
    .join(' ')
  return (
    <button type="button" className={cls} {...rest}>
      {children}
    </button>
  )
}

/* ------------------------------------------------------------------ */
/* Badge                                                               */
/* ------------------------------------------------------------------ */

export function Badge({
  tone = 'gray',
  dot = true,
  pulse = false,
  children,
  title
}: {
  tone?: string
  dot?: boolean
  pulse?: boolean
  children: React.ReactNode
  title?: string
}): React.ReactElement {
  return (
    <span className={`badge tone-${tone}`} title={title}>
      {dot && <span className={`dot${pulse ? ' dot-pulse' : ''}`} />}
      {children}
    </span>
  )
}

/* ------------------------------------------------------------------ */
/* Card                                                                */
/* ------------------------------------------------------------------ */

export function Card({
  title,
  extra,
  children,
  className,
  bodyStyle
}: {
  title?: React.ReactNode
  extra?: React.ReactNode
  children: React.ReactNode
  className?: string
  bodyStyle?: React.CSSProperties
}): React.ReactElement {
  return (
    <section className={`card${className ? ` ${className}` : ''}`}>
      {(title || extra) && (
        <div className="card-header">
          <span>{title}</span>
          <span className="spacer" />
          {extra}
        </div>
      )}
      <div className="card-body" style={bodyStyle}>
        {children}
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* Field                                                               */
/* ------------------------------------------------------------------ */

export function Field({
  label,
  hint,
  error,
  children
}: {
  label?: string
  hint?: string
  error?: string | null
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div className="field">
      {label && <label>{label}</label>}
      {children}
      {error ? <span className="error">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  )
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>): React.ReactElement {
  return <input className="input" {...props} />
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>): React.ReactElement {
  return <textarea className="textarea" {...props} />
}

export function Select({
  options,
  ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement> & {
  options: Array<{ value: string; label: string }>
}): React.ReactElement {
  return (
    <select className="select" {...rest}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function Checkbox({
  checked,
  onChange,
  label,
  disabled
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: React.ReactNode
  disabled?: boolean
}): React.ReactElement {
  return (
    <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, cursor: disabled ? 'not-allowed' : 'pointer' }}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{ marginTop: 3 }}
      />
      <span>{label}</span>
    </label>
  )
}

/* ------------------------------------------------------------------ */
/* Tabs                                                                */
/* ------------------------------------------------------------------ */

export function Tabs<T extends string>({
  items,
  value,
  onChange
}: {
  items: Array<{ key: T; label: React.ReactNode; disabled?: boolean; title?: string }>
  value: T
  onChange: (key: T) => void
}): React.ReactElement {
  return (
    <div className="tabs" role="tablist">
      {items.map((item) => (
        <button
          key={item.key}
          role="tab"
          aria-selected={value === item.key}
          className={`tab${value === item.key ? ' active' : ''}`}
          disabled={item.disabled}
          title={item.title}
          onClick={() => onChange(item.key)}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Modal / Confirm / Reason                                            */
/* ------------------------------------------------------------------ */

export function Modal({
  open,
  title,
  children,
  footer,
  wide,
  onClose
}: {
  open: boolean
  title: React.ReactNode
  children: React.ReactNode
  footer?: React.ReactNode
  wide?: boolean
  onClose?: () => void
}): React.ReactElement | null {
  useEffect(() => {
    if (!open || !onClose) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-header">
          <span>{title}</span>
          <span className="spacer" />
          {onClose && (
            <Button kind="ghost" size="sm" onClick={onClose} aria-label="关闭">
              ✕
            </Button>
          )}
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  )
}

export interface ConfirmOptions {
  title: string
  message: React.ReactNode
  okText?: string
  cancelText?: string
  danger?: boolean
}

export function useConfirm(): (options: ConfirmOptions) => Promise<boolean> {
  const [state, setState] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null)
  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setState({ ...options, resolve })
      }),
    []
  )
  const node = state ? (
    <Modal
      open
      title={state.title}
      onClose={() => {
        state.resolve(false)
        setState(null)
      }}
      footer={
        <>
          <Button
            onClick={() => {
              state.resolve(false)
              setState(null)
            }}
          >
            {state.cancelText ?? '取消'}
          </Button>
          <Button
            kind={state.danger ? 'danger' : 'primary'}
            onClick={() => {
              state.resolve(true)
              setState(null)
            }}
          >
            {state.okText ?? '确定'}
          </Button>
        </>
      }
    >
      <div style={{ fontSize: 13, lineHeight: 1.6 }}>{state.message}</div>
    </Modal>
  ) : null
  return useMemo(() => {
    const fn = confirm as ((o: ConfirmOptions) => Promise<boolean>) & { node?: React.ReactNode }
    fn.node = node
    return fn
  }, [confirm, node])
}

export function ConfirmHost({ confirm }: { confirm: ReturnType<typeof useConfirm> }): React.ReactElement | null {
  const node = (confirm as unknown as { node?: React.ReactNode }).node
  return <>{node ?? null}</>
}

export function ReasonDialog({
  open,
  title,
  label,
  minLength = 0,
  okText = '提交',
  onCancel,
  onSubmit
}: {
  open: boolean
  title: string
  label: string
  minLength?: number
  okText?: string
  onCancel: () => void
  onSubmit: (text: string) => void
}): React.ReactElement | null {
  const [text, setText] = useState('')
  useEffect(() => {
    if (open) setText('')
  }, [open])
  const tooShort = text.trim().length < minLength
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>取消</Button>
          <Button kind="primary" disabled={tooShort} onClick={() => onSubmit(text.trim())}>
            {okText}
          </Button>
        </>
      }
    >
      <Field
        label={label}
        hint={minLength > 0 ? `至少 ${minLength} 个字，将写入审计日志` : '将写入审计日志'}
        error={text.length > 0 && tooShort ? `还需 ${minLength - text.trim().length} 个字` : null}
      >
        <TextArea value={text} onChange={(e) => setText(e.target.value)} rows={4} autoFocus />
      </Field>
    </Modal>
  )
}

/* ------------------------------------------------------------------ */
/* Toast                                                               */
/* ------------------------------------------------------------------ */

export type ToastKind = 'info' | 'success' | 'warn' | 'error'

interface ToastItem {
  id: number
  kind: ToastKind
  message: string
}

const ToastContext = createContext<{
  push: (kind: ToastKind, message: string) => void
}>({ push: () => undefined })

export function ToastProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [items, setItems] = useState<ToastItem[]>([])
  const nextId = useRef(1)

  const push = useCallback((kind: ToastKind, message: string) => {
    const id = nextId.current++
    setItems((prev) => [...prev, { id, kind, message }])
    setTimeout(() => {
      setItems((prev) => prev.filter((item) => item.id !== id))
    }, kind === 'error' ? 6500 : 3500)
  }, [])

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div className="toast-layer">
        {items.map((item) => (
          <div key={item.id} className={`toast${item.kind === 'info' ? '' : ` ${item.kind}`}`}>
            <span>{item.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): { info: (m: string) => void; success: (m: string) => void; warn: (m: string) => void; error: (m: string) => void } {
  const { push } = useContext(ToastContext)
  return useMemo(
    () => ({
      info: (m: string) => push('info', m),
      success: (m: string) => push('success', m),
      warn: (m: string) => push('warn', m),
      error: (m: string) => push('error', m)
    }),
    [push]
  )
}

/* ------------------------------------------------------------------ */
/* Empty / Progress / Drawer                                           */
/* ------------------------------------------------------------------ */

export function EmptyState({
  title,
  description,
  action
}: {
  title: string
  description?: string
  action?: React.ReactNode
}): React.ReactElement {
  return (
    <div className="empty">
      <div className="title">{title}</div>
      {description && <div>{description}</div>}
      {action}
    </div>
  )
}

export function Progress({ percent }: { percent: number }): React.ReactElement {
  return (
    <div className="progress">
      <i style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
    </div>
  )
}

export function Drawer({
  open,
  title,
  onClose,
  children,
  width
}: {
  open: boolean
  title: React.ReactNode
  onClose: () => void
  children: React.ReactNode
  width?: number
}): React.ReactElement | null {
  if (!open) return null
  return (
    <div className="drawer" style={width ? { width } : undefined}>
      <div className="card-header">
        <span>{title}</span>
        <span className="spacer" />
        <Button kind="ghost" size="sm" onClick={onClose}>
          ✕
        </Button>
      </div>
      <div style={{ padding: 12, overflow: 'auto', flex: 1 }}>{children}</div>
    </div>
  )
}

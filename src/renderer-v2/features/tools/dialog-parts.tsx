import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import { Button, useDialogClose, type ButtonProps } from '../../ui'

export interface RadioCardOption { value: string; label: ReactNode; badge?: ReactNode; description?: ReactNode; disabled?: boolean; testId?: string }

/**
 * v4 原型的单选卡片：配置弹窗的三种来源横排，「换用别家模型」的模型列表竖排。
 * 和系统的单选按钮一样，一组只有一格能 Tab 进去，方向键换选中项。
 */
export function RadioCards({ label, value, options, onChange, layout = 'row', testId }: {
  label: string
  value: string
  options: RadioCardOption[]
  onChange(value: string): void
  layout?: 'row' | 'stack'
  testId?: string
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const enabled = options.flatMap((option, index) => option.disabled ? [] : [index])
  const selected = options.findIndex((option) => option.value === value && !option.disabled)
  const entry = selected >= 0 ? selected : enabled[0] ?? -1
  function move(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
    if (!step || event.nativeEvent.isComposing || !enabled.length) return
    event.preventDefault()
    const current = enabled.indexOf(index)
    const next = enabled[(current + step + enabled.length) % enabled.length]
    refs.current[next]?.focus()
    onChange(options[next].value)
  }
  return <div className={layout === 'row' ? 'v2-radio-cards' : 'v2-radio-cards is-stack'} role="radiogroup" aria-label={label} data-testid={testId}>
    {options.map((option, index) => <button key={option.value} ref={(node) => { refs.current[index] = node }} type="button" role="radio"
      className="v2-radio-card" aria-checked={option.value === value} tabIndex={index === entry ? 0 : -1} disabled={option.disabled}
      data-testid={option.testId} onClick={() => { if (option.value !== value) onChange(option.value) }} onKeyDown={(event) => move(event, index)}>
      <span className="v2-radio-dot" aria-hidden="true" />
      <span className="v2-radio-card-text"><span className="v2-radio-card-label">{option.label}{option.badge}</span>{option.description && <small>{option.description}</small>}</span>
    </button>)}
  </div>
}

/**
 * 底栏「取消」和离开弹窗去别的页的链接：有没保存的修改时和点 × 一样先亮离开条，
 * after 等弹窗真关了才跑（点「不保存」也算）。只能放在 Dialog 里面，外面拿不到它的关闭。
 */
export function DialogExitButton({ after, children, ...props }: Omit<ButtonProps, 'onClick'> & { after?(): void }) {
  const close = useDialogClose()
  return <Button {...props} onClick={() => close(after)}>{children}</Button>
}

export function DialogExitLink({ after, disabled, testId, children }: { after?(): void; disabled?: boolean; testId?: string; children: ReactNode }) {
  const close = useDialogClose()
  return <button type="button" className="v2-link-button" disabled={disabled} data-testid={testId} onClick={() => close(after)}>{children}</button>
}

import { useId, useRef, useState, type ReactElement } from 'react'
import { Check, type LucideIcon } from 'lucide-react'
import { FloatingSurface, withAnchorRef } from './Floating'

export interface MenuItem {
  id: string
  label: string
  icon?: LucideIcon
  disabled?: boolean
  danger?: boolean
  checked?: boolean
  separatorBefore?: boolean
  onSelect(): void
}

export interface MenuProps { trigger: ReactElement; label: string; items: readonly MenuItem[]; open?: boolean; onOpenChange?(open: boolean): void; testId?: string }

export function Menu({ trigger, label, items, open: controlledOpen, onOpenChange, testId }: MenuProps) {
  const id = useId()
  const anchor = useRef<HTMLElement | null>(null)
  const [localOpen, setLocalOpen] = useState(false)
  const open = controlledOpen ?? localOpen
  const [initialFocus, setInitialFocus] = useState<'first' | 'last'>('first')
  const search = useRef({ text: '', at: 0 })
  const setOpen = (next: boolean) => { setLocalOpen(next); onOpenChange?.(next) }
  const available = items.filter((item) => !item.disabled)
  const initialId = initialFocus === 'last' ? available.at(-1)?.id : available[0]?.id
  return <>{withAnchorRef(trigger, anchor, {
    'aria-haspopup': 'menu', 'aria-expanded': open, 'aria-controls': open ? id : undefined,
    onClick: (event: React.MouseEvent) => { trigger.props.onClick?.(event); if (!event.defaultPrevented) { setInitialFocus('first'); setOpen(!open) } },
    onKeyDown: (event: React.KeyboardEvent) => {
      trigger.props.onKeyDown?.(event)
      if (event.defaultPrevented || event.nativeEvent.isComposing || !['ArrowDown', 'ArrowUp'].includes(event.key)) return
      event.preventDefault(); event.stopPropagation(); setInitialFocus(event.key === 'ArrowUp' ? 'last' : 'first'); setOpen(true)
    },
  })}{open && <FloatingSurface anchor={anchor} role="menu" id={id} label={label} testId={testId} className="ui-menu" autoFocus onDismiss={() => setOpen(false)} onKeyDown={(event) => {
    if (event.nativeEvent.isComposing) return
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')]
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    let next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : event.key === 'ArrowDown' ? (index + 1) % buttons.length : event.key === 'ArrowUp' ? (index - 1 + buttons.length) % buttons.length : -1
    if (event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      search.current.text = Date.now() - search.current.at < 600 ? search.current.text + event.key : event.key
      search.current.at = Date.now()
      next = buttons.findIndex((button) => button.textContent?.trim().toLocaleLowerCase().startsWith(search.current.text.toLocaleLowerCase()))
    }
    if (next >= 0 && buttons[next]) { event.preventDefault(); buttons[next].focus() }
    if (event.key === 'Tab') setOpen(false)
  }}>{items.map(({ id: itemId, label: itemLabel, icon: Icon, checked, disabled, danger, separatorBefore, onSelect }) => <div key={itemId} role="none">
    {separatorBefore && <div className="ui-menu-separator" role="separator" />}
    <button type="button" role={checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={checked} disabled={disabled} className="ui-menu-item" data-danger={danger || undefined}
      data-initial-focus={itemId === initialId ? '' : undefined} onClick={() => { if (disabled) return; setOpen(false); anchor.current?.focus({ preventScroll: true }); onSelect() }}>
      {Icon && <Icon size={16} aria-hidden="true" />}<span>{itemLabel}</span>{checked && <Check size={15} aria-hidden="true" />}
    </button>
  </div>)}</FloatingSurface>}</>
}

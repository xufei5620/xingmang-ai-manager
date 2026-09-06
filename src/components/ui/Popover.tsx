import { useId, useRef, type ReactElement, type ReactNode } from 'react'
import { FloatingSurface, withAnchorRef, type FloatingDismissReason, type FloatingSide } from './Floating'

export interface PopoverProps {
  trigger: ReactElement
  open: boolean
  onOpenChange(open: boolean, reason?: FloatingDismissReason | 'toggle'): void
  label: string
  children: ReactNode
  side?: FloatingSide
  align?: 'start' | 'center' | 'end'
  width?: number
  testId?: string
}

export function Popover({ trigger, open, onOpenChange, label, children, side, align, width = 320, testId }: PopoverProps) {
  const anchor = useRef<HTMLElement | null>(null)
  const id = useId()
  return <>{withAnchorRef(trigger, anchor, {
    'aria-haspopup': 'dialog', 'aria-expanded': open, 'aria-controls': open ? id : undefined,
    onClick: (event: React.MouseEvent) => { trigger.props.onClick?.(event); if (!event.defaultPrevented) onOpenChange(!open, 'toggle') },
  })}{open && <FloatingSurface anchor={anchor} id={id} label={label} testId={testId} side={side} align={align} width={width} autoFocus onDismiss={(reason) => onOpenChange(false, reason)}>{children}</FloatingSurface>}</>
}

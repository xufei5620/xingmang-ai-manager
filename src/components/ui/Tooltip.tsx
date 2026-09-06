import { useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { FloatingSurface, withAnchorRef, type FloatingSide } from './Floating'

export function Tooltip({ children, content, side = 'top', delay = 350, testId }: { children: ReactElement; content: ReactNode; side?: FloatingSide; delay?: number; testId?: string }) {
  const id = useId()
  const anchor = useRef<HTMLElement | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const [open, setOpen] = useState(false)
  const hide = () => { clearTimeout(timer.current); setOpen(false) }
  const show = (immediate = false) => {
    clearTimeout(timer.current)
    if (immediate) setOpen(true)
    else timer.current = setTimeout(() => setOpen(true), delay)
  }
  useEffect(() => () => clearTimeout(timer.current), [])
  return <><span className="ui-tooltip-anchor" onPointerEnter={() => show()} onPointerLeave={hide} onFocus={() => show(true)} onBlur={hide} onPointerDown={hide}>
    {withAnchorRef(children, anchor, { 'aria-describedby': [children.props['aria-describedby'], open ? id : undefined].filter(Boolean).join(' ') || undefined })}
  </span>{open && <FloatingSurface anchor={anchor} role="tooltip" id={id} testId={testId} className="ui-tooltip" side={side} align="center" onDismiss={hide} dismissOutside={false}>{content}</FloatingSurface>}</>
}

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { FloatingSurface, isVisibleAnchor } from './Floating'

export interface CoachmarkProps {
  open: boolean
  target(): HTMLElement | null
  title: string
  children: ReactNode
  onSkip(): void
  onComplete(): void
  reducedMotion: boolean
  onReducedMotionChange(value: boolean): void
  onTargetMissing?(): void
  testId?: string
}

export function Coachmark(props: CoachmarkProps) {
  const callbacks = useRef(props)
  callbacks.current = props
  const anchor = useRef<HTMLElement | null>(null)
  const visibilityRef = useRef(false)
  const [visible, setVisible] = useState(false)
  const target = props.open ? props.target() : null
  useEffect(() => {
    if (!props.open) { setVisible(false); visibilityRef.current = false; anchor.current = null; return }
    let frame = 0
    const update = () => {
      const target = callbacks.current.target()
      const nextVisible = isVisibleAnchor(target)
      anchor.current = nextVisible ? target : null
      setVisible(nextVisible)
      if (visibilityRef.current && !nextVisible) callbacks.current.onTargetMissing?.()
      visibilityRef.current = nextVisible
    }
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update) }
    update()
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'style', 'class'] })
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    return () => { cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener('resize', schedule); window.removeEventListener('scroll', schedule, true); anchor.current = null }
  }, [props.open, target])
  if (!props.open || !visible) return null
  return <FloatingSurface anchor={anchor} label={props.title} testId={props.testId} className="ui-coachmark" width={320} autoFocus dismissOutside={false} onDismiss={(reason) => { if (reason === 'anchor-hidden') { setVisible(false); if (visibilityRef.current) props.onTargetMissing?.(); visibilityRef.current = false } else props.onSkip() }}>
    <strong className="ui-coachmark-title">{props.title}</strong><div className="ui-coachmark-content">{props.children}</div>
    <label className="ui-coachmark-motion"><input type="checkbox" checked={props.reducedMotion} onChange={(event) => props.onReducedMotionChange(event.target.checked)} />减少动画</label>
    <div className="ui-coachmark-actions"><button type="button" className="ui-button" data-size="sm" onClick={props.onSkip}>跳过</button><button type="button" className="ui-button" data-size="sm" data-variant="primary" onClick={props.onComplete}>完成</button></div>
  </FloatingSurface>
}

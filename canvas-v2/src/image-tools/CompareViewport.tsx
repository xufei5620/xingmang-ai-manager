import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Hand, Maximize, ZoomIn, ZoomOut } from 'lucide-react'
import { createCompareViewportInteraction } from './compare-viewport-state'

interface CompareViewportProps {
  label: string
  scopeKey: string
  disabled: boolean
  slider?: boolean
  children(style: CSSProperties): ReactNode
}

/** Each parallel/grid cell owns its session; the slider shares one aligned view. */
export function CompareViewport({ label, scopeKey, disabled, slider = false, children }: CompareViewportProps) {
  const stage = useRef<HTMLDivElement>(null)
  const [, redraw] = useState(0)
  const [hand, setHand] = useState(false)
  const [space, setSpace] = useState(false)
  const current = useRef({ scopeKey, disabled })
  current.current = { scopeKey, disabled }
  const interaction = useRef<ReturnType<typeof createCompareViewportInteraction> | null>(null)
  if (!interaction.current) interaction.current = createCompareViewportInteraction(() => redraw((value) => value + 1))
  interaction.current.sync(scopeKey, !disabled)
  const view = interaction.current.read()
  const panMode = !slider || hand || space
  function bounds() { const rect = stage.current?.querySelector('.image-compare-stage, .image-compare-cell')?.getBoundingClientRect(); return { width: rect?.width ?? 0, height: rect?.height ?? 0 } }
  function active() { return current.current.scopeKey === scopeKey && !current.current.disabled }
  useEffect(() => {
    interaction.current?.sync(scopeKey, !current.current.disabled)
    setHand(false); setSpace(false)
    const target = stage.current
    if (!target) return
    function wheel(event: WheelEvent) {
      if (!active()) return
      event.preventDefault(); event.stopPropagation()
      interaction.current?.zoom(event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 200 : 1), bounds())
    }
    target.addEventListener('wheel', wheel, { passive: false })
    return () => { target.removeEventListener('wheel', wheel); if (current.current.scopeKey === scopeKey) interaction.current?.sync('', false) }
  }, [scopeKey])
  return <div className="image-compare-viewport">
    <div ref={stage} className={`image-compare-viewport-stage${panMode && view.scale > 1 ? ' can-pan' : ''}`} role="region" tabIndex={disabled ? -1 : 0} aria-label={`${label}查看区域，滚轮缩放，放大后拖动平移，Home 适配`} aria-disabled={disabled}
      onPointerDownCapture={(event) => {
        if (!active() || event.button !== 0) return
        if (event.isPrimary === false) { event.preventDefault(); event.stopPropagation(); return }
        event.currentTarget.focus()
        if (!panMode) return
        // Hand/Space owns the gesture even at fit scale, where panning is a no-op.
        // Letting that press bubble would start a persistent slider edit instead.
        event.preventDefault(); event.stopPropagation()
        if (!interaction.current?.start(event.pointerId, event.clientX, event.clientY, bounds())) return
        try { event.currentTarget.setPointerCapture(event.pointerId) } catch { interaction.current.cancel(event.pointerId) }
      }}
      onPointerMoveCapture={(event) => { if (active() && interaction.current?.pending() === event.pointerId) { event.preventDefault(); event.stopPropagation(); interaction.current.move(event.pointerId, event.clientX, event.clientY) } }}
      onPointerUpCapture={(event) => { if (interaction.current?.pending() === event.pointerId) { event.stopPropagation(); interaction.current.finish(event.pointerId) } }}
      onPointerCancel={(event) => interaction.current?.cancel(event.pointerId)} onLostPointerCapture={(event) => interaction.current?.cancel(event.pointerId)}
      onKeyDown={(event) => {
        if (!active() || event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) return
        if (event.key === 'Escape' && interaction.current?.pending() !== null) { event.preventDefault(); event.stopPropagation(); interaction.current?.cancel(); return }
        if (event.key === ' ') { event.preventDefault(); event.stopPropagation(); setSpace(true); return }
        if (interaction.current?.key(event.key, bounds())) { event.preventDefault(); event.stopPropagation() }
      }}
      onKeyUp={(event) => { if (event.key === ' ') { event.preventDefault(); event.stopPropagation(); setSpace(false) } }}
      onBlur={() => { setSpace(false); interaction.current?.cancel() }}>
      {children({ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, transformOrigin: 'center' })}
    </div>
    <div className="image-compare-viewport-toolbar" role="toolbar" aria-label={`${label}缩放和平移`}>
      <button type="button" aria-label={`缩小${label}`} disabled={disabled || view.scale <= 1} onClick={() => interaction.current?.scale(view.scale / 1.25, bounds())}><ZoomOut size={13} /></button>
      <output aria-label={`${label}适配缩放倍数`}>{Number(view.scale.toFixed(2))}×</output>
      <button type="button" aria-label={`放大${label}`} disabled={disabled || view.scale >= 8} onClick={() => interaction.current?.scale(view.scale * 1.25, bounds())}><ZoomIn size={13} /></button>
      <button type="button" aria-label={`适配${label}`} title="适配并居中" disabled={disabled} onClick={() => interaction.current?.reset()}><Maximize size={13} /></button>
      {slider && <button type="button" aria-label="平移对比图片" title="手形平移，或按住空格拖动" aria-pressed={hand} disabled={disabled} onClick={() => setHand((value) => !value)}><Hand size={13} /></button>}
    </div>
  </div>
}

import { useLayoutEffect, useState, type ReactNode } from 'react'
import { NodeToolbar, Position, useStore } from '@xyflow/react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { composerPlacement } from './composer-placement'

export function ComposerPanel({ id, title, follow, collapsed, onCollapsedChange, children }: { id: string; title: string; follow: boolean; collapsed: boolean; onCollapsedChange?(value: boolean): void; children: ReactNode }) {
  const geometry = useStore((state) => {
    const node = state.nodeLookup.get(id)
    const zoom = state.transform[2]
    return [state.width, state.height, (node?.internals.positionAbsolute.x ?? 0) * zoom + state.transform[0], (node?.internals.positionAbsolute.y ?? 0) * zoom + state.transform[1], (node?.measured.width ?? 280) * zoom, (node?.measured.height ?? 280) * zoom]
  }, (left, right) => left.every((value, index) => value === right[index]))
  // NodeToolbar may attach its portal after this component's first effect.
  // Observe the actual element lifecycle rather than only the initial render.
  const [panel, setPanel] = useState<HTMLDivElement | null>(null)
  const [panelHeight, setPanelHeight] = useState(360)
  useLayoutEffect(() => {
    const element = panel
    if (!element) return
    let lastHeight: number | undefined
    let frame: number | undefined
    let disposed = false
    const measure = () => {
      if (disposed) return
      const height = element.offsetHeight
      if (height === lastHeight) return
      lastHeight = height
      setPanelHeight((current) => height === current ? current : height)
    }
    measure()
    // Moving the toolbar can trigger React Flow's own size observers. Never
    // write React layout state inside the current ResizeObserver delivery.
    const observer = new ResizeObserver(() => {
      if (disposed || frame !== undefined) return
      frame = requestAnimationFrame(() => { frame = undefined; measure() })
    })
    observer.observe(element)
    return () => {
      disposed = true
      observer.disconnect()
      if (frame !== undefined) cancelAnimationFrame(frame)
    }
  }, [panel])
  const placement = composerPlacement({ viewport: { width: geometry[0] || 800, height: geometry[1] || 600 }, node: { x: geometry[2], y: geometry[3], width: geometry[4], height: geometry[5] }, panelHeight: collapsed ? 58 : panelHeight, follow })
  return <NodeToolbar nodeId={id} position={Position.Bottom} className="nodrag nowheel" style={{ transform: 'none', left: placement.left, top: placement.top, width: placement.width }}>
    <div ref={setPanel} className={`wf-composer wf-editor-composer${collapsed ? ' is-collapsed' : ''}`} style={{ width: '100%', maxHeight: placement.maxHeight }} role="dialog" aria-label={`${title}生成条`} data-placement={placement.mode} data-node-id={id}>
      <div className="wf-composer-heading">
        <span><strong>{title}</strong><small>{collapsed ? '输入区已收起' : follow && placement.mode === 'fixed' ? '空间不足，输入区已固定' : placement.mode === 'follow' ? '输入区跟随节点' : '提示词与生成参数'}</small></span>
        <button type="button" className="wf-composer-collapse" aria-label={collapsed ? '展开生成输入区' : '收起生成输入区'} aria-expanded={!collapsed} onClick={() => onCollapsedChange?.(!collapsed)}>{collapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</button>
      </div>
      <div className="wf-composer-body" hidden={collapsed}>{children}</div>
    </div>
  </NodeToolbar>
}

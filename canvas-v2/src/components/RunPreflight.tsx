import { useEffect, useRef } from 'react'
import type { CanvasRunPreflight } from '../runtime/run-preflight'
import { AlertTriangle, CheckCircle2, CircleDollarSign, X } from 'lucide-react'

interface RunPreflightProps {
  preflight: CanvasRunPreflight
  onCancel(): void
  onConfigure(): void
  onConfirm(): void
}

export function RunPreflight({ preflight, onCancel, onConfigure, onConfirm }: RunPreflightProps) {
  const dialogRef = useRef<HTMLElement>(null)
  useEffect(() => {
    const dialog = dialogRef.current
    const first = dialog?.querySelector<HTMLElement>('button:not([disabled])')
    first?.focus()
  }, [])

  const trapFocus = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onCancel()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? [])]
    if (focusable.length === 0) return
    const current = document.activeElement
    const index = focusable.indexOf(current as HTMLElement)
    const next = event.shiftKey
      ? focusable[(index <= 0 ? focusable.length : index) - 1]
      : focusable[(index + 1) % focusable.length]
    event.preventDefault()
    next.focus()
  }

  return (
    <div className="run-preflight-backdrop" role="presentation">
      <section ref={dialogRef} className="run-preflight" role="dialog" aria-modal="true" aria-label="运行前检查" onKeyDown={trapFocus}>
        <header>
          <span><CircleDollarSign size={17} aria-hidden="true" /><strong>运行前检查</strong></span>
          <button type="button" title="关闭" aria-label="关闭运行前检查" onClick={onCancel}><X size={16} /></button>
        </header>
        <div className="run-preflight-summary">
          <div><strong>{preflight.selectedNodeIds.length}</strong><span>个节点</span></div>
          <div><strong>{preflight.requestCount}</strong><span>个执行项</span></div>
          <div><strong>{preflight.cacheHitCount}</strong><span>个缓存</span></div>
          <div className={preflight.paidRequestCount > 0 ? 'is-warning' : ''}><strong>{preflight.paidRequestCount}</strong><span>个付费请求</span></div>
        </div>
        <p className="run-preflight-scope">{preflight.warnings[0] ?? '当前运行范围'}</p>
        {preflight.blockedCount > 0 && (
          <div className="run-preflight-blocking" role="alert"><AlertTriangle size={15} /><span>{preflight.blockedCount} 个节点阻塞，修复配置后才能运行。</span></div>
        )}
        <div className="run-preflight-details">
          <div><span>分组</span><strong>{preflight.groups.join('、') || '无'}</strong></div>
          <div><span>模型</span><strong>{preflight.models.join('、') || '无'}</strong></div>
        </div>
        <ul className="run-preflight-items">
          {preflight.items.map((item) => (
            <li key={item.nodeId} className={`is-${item.action}`}>
              {item.action === 'blocked' ? <AlertTriangle size={13} /> : item.action === 'cached' ? <CheckCircle2 size={13} /> : <span className="run-preflight-dot" />}
              <span><strong>{item.kind}</strong><small>{item.reason ?? (item.action === 'cached' ? '复用已有结果' : item.action === 'skip' ? '已跳过' : item.paid ? '将提交付费生成请求' : '本地处理')}</small></span>
            </li>
          ))}
        </ul>
        {preflight.paidRequestCount > 0 && <p className="run-preflight-warning">本次最多提交 {preflight.paidRequestCount} 个付费请求，仅缓存未命中时才会提交；停止等待不代表上游已取消，请勿因不确定结果立即重复提交。</p>}
        <footer>
          <button type="button" onClick={onCancel}>取消</button>
          {preflight.blockedCount > 0 && <button type="button" onClick={onConfigure}>打开生成配置</button>}
          <button type="button" className="is-primary" disabled={!preflight.canStart} onClick={onConfirm}>确认运行</button>
        </footer>
      </section>
    </div>
  )
}

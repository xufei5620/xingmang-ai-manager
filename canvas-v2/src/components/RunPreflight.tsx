import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import type { CanvasRunPreflight } from '../runtime/run-preflight'
import { AlertTriangle, CheckCircle2, CircleDollarSign, X } from 'lucide-react'
import { buildPreflightPresentation, createPreflightConfirmation, type PreflightConfirmationState } from './run-preflight-presentation'
import './run-preflight.css'

interface RunPreflightProps {
  preflight: CanvasRunPreflight
  onCancel(): void
  onConfigure(): void
  onConfirm(): void | Promise<void>
}

export function RunPreflight({ preflight, onCancel, onConfigure, onConfirm }: RunPreflightProps) {
  const dialogRef = useRef<HTMLElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const activeRef = useRef(false)
  const confirmationRef = useRef(createPreflightConfirmation())
  const [confirmation, setConfirmation] = useState<PreflightConfirmationState>('idle')
  const descriptionId = useId()
  const presentation = buildPreflightPresentation(preflight)
  const submitted = confirmation !== 'idle'

  useEffect(() => {
    activeRef.current = true
    const previous = document.activeElement
    const dialog = dialogRef.current
    // Focus the non-destructive action; Enter must not accidentally spend.
    cancelRef.current?.focus()
    return () => {
      activeRef.current = false
      const current = document.activeElement
      if (previous instanceof HTMLElement && previous.isConnected
        && (current === document.body || (current !== null && dialog?.contains(current)))) {
        previous.focus()
      }
    }
  }, [])

  function trapFocus(event: KeyboardEvent<HTMLElement>): void {
    // Canvas shortcuts must not delete/edit background nodes through a modal.
    event.stopPropagation()
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape') {
      event.preventDefault()
      onCancel()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), summary, [tabindex="0"]') ?? [])]
      .filter((element) => element.getClientRects().length > 0 && !element.closest('[hidden], [inert]'))
    event.preventDefault()
    if (focusable.length === 0) { dialogRef.current?.focus(); return }
    const index = focusable.findIndex((element) => element === document.activeElement)
    const next = event.shiftKey ? (index <= 0 ? focusable.length : index) - 1 : (index + 1) % focusable.length
    focusable[next].focus()
  }

  async function confirm(): Promise<void> {
    const request = confirmationRef.current.submit(presentation.canConfirm, onConfirm)
    setConfirmation(confirmationRef.current.state())
    await request
    if (activeRef.current) setConfirmation(confirmationRef.current.state())
  }

  return (
    <div className="run-preflight-backdrop" role="presentation">
      <section ref={dialogRef} className="run-preflight is-guided" role="dialog" aria-modal="true" aria-label="运行前检查" aria-describedby={descriptionId} tabIndex={-1} onKeyDown={trapFocus}>
        <header>
          <span><CircleDollarSign size={17} aria-hidden="true" /><strong>{presentation.headline}</strong></span>
          <button type="button" title="关闭" aria-label="关闭运行前检查" onClick={onCancel}><X size={16} /></button>
        </header>
        <div className="preflight-content">
          <p className="preflight-lead" id={descriptionId}>{presentation.summary}</p>
          <p className="run-preflight-scope">范围：{preflight.warnings[0] ?? '当前选择'}。包含所需的上游步骤。</p>
          {presentation.blockedItems.length > 0 && <section className="preflight-problems" aria-label="需要处理的问题" role="alert">
            <p><AlertTriangle size={15} aria-hidden="true" />处理完成前，不会从这里提交本次运行。</p>
            <ul>{presentation.blockedItems.map((item) => <li key={item.nodeId}>
              <strong>{item.title}</strong><span>{item.detail}</span><small>节点：{item.nodeId}</small>
            </li>)}</ul>
          </section>}
          <p className="run-preflight-warning">{presentation.costNotice}</p>
          {presentation.retryNotice && <p className="preflight-retry-notice">{presentation.retryNotice}</p>}
          <details className="preflight-plan">
            <summary>查看全部 {presentation.items.length} 项处理明细、模型与分组</summary>
            <div className="run-preflight-details">
              <div><span>分组</span><strong>{preflight.groups.join('、') || '无需生成分组'}</strong></div>
              <div><span>模型</span><strong>{preflight.models.join('、') || '无需生成模型'}</strong></div>
            </div>
            <ul className="run-preflight-items">
              {presentation.items.map((item) => <li key={item.nodeId} className={`is-${item.action}`}>
                {item.action === 'blocked' ? <AlertTriangle size={13} aria-hidden="true" />
                  : item.action === 'cached' ? <CheckCircle2 size={13} aria-hidden="true" /> : <span className="run-preflight-dot" />}
                <span><strong>{item.title}</strong><small>{item.detail}</small><small>节点：{item.nodeId}</small></span>
              </li>)}
            </ul>
          </details>
          {confirmation === 'submitting' && <p role="status">正在提交，请勿重复确认。</p>}
          {confirmation === 'submitted' && <p role="status">已交给运行服务处理，请返回画布查看记录。</p>}
          {confirmation === 'uncertain' && <p role="alert">无法确认提交结果，已暂停重复提交。请返回画布检查生成记录，再决定是否重试。</p>}
        </div>
        <footer>
          <button ref={cancelRef} type="button" onClick={onCancel}>{submitted ? '返回画布' : '返回修改'}</button>
          {presentation.canConfigure && <button type="button" onClick={onConfigure} disabled={submitted}>打开生成配置</button>}
          <button type="button" className="is-primary" aria-label="确认运行" data-testid="canvas-preflight-confirm" disabled={!presentation.canConfirm || submitted} onClick={() => void confirm()}>{submitted ? '已确认' : presentation.confirmLabel}</button>
        </footer>
      </section>
    </div>
  )
}

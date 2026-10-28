import { useEffect, useRef } from 'react'
import { parseWorkflowFile } from '../model'
import type { SavedTemplateProjectSubmission } from '../templates/template-project-creation'

export interface TemplateProjectRecoveryProps {
  submission: SavedTemplateProjectSubmission
  error: string | null
  busy: boolean
  onRetry(): void
  onExport(): void
  onClose(): void
}

export function TemplateProjectRecovery({ submission, error, busy, onRetry, onExport, onClose }: TemplateProjectRecoveryProps) {
  const dialog = useRef<HTMLDivElement>(null)
  const workflow = parseWorkflowFile(submission.content)
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog.current?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [])

  return <div className="canvas-project-dialog-backdrop">
    <div ref={dialog} className="canvas-project-dialog" role="dialog" aria-modal="true" aria-labelledby="canvas-template-recovery-title" tabIndex={-1} aria-busy={busy} onKeyDown={(event) => {
      event.stopPropagation()
      if (event.key === 'Escape') { event.preventDefault(); if (!busy) onClose(); return }
      if (event.key !== 'Tab') return
      const controls = [...(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
      if (!controls.length) { event.preventDefault(); return }
      const first = controls[0]
      const last = controls[controls.length - 1]
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus() }
    }}>
      <header><strong id="canvas-template-recovery-title">核对原模板工程</strong></header>
      <p>已保留原配置与完整工作流。{workflow ? `「${workflow.name}」包含 ${workflow.nodes.length} 个节点、${workflow.edges.length} 条连线。` : '请保留浏览器数据并先导出工作流。'}</p>
      <p>核对会继续使用原操作编号，不会改为默认配置或自动执行生成任务。暂时返回后，恢复记录仍会保留。</p>
      {error && <p className="canvas-project-dialog-error" role="alert">{error}</p>}
      {busy && <p role="status">正在核对原创建结果，请等待确认。</p>}
      <footer>
        <button type="button" disabled={busy} onClick={onClose}>暂时返回</button>
        <button type="button" disabled={busy} onClick={onExport}>导出工作流</button>
        <button type="button" className="is-primary" disabled={busy || !workflow} onClick={onRetry}>核对原创建</button>
      </footer>
    </div>
  </div>
}

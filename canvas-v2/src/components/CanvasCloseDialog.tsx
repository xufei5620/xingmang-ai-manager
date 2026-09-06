import { useEffect, useRef } from 'react'
import { LoaderCircle, Save, Square, X } from 'lucide-react'
import type { CanvasCloseChoice, CanvasClosePhase } from '../persistence/canvas-close'

export function CanvasCloseDialog({ phase, onChoose, onCancel }: {
  phase: CanvasClosePhase
  onChoose(choice: CanvasCloseChoice): void
  onCancel(): void
}) {
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const root = document.getElementById('root')
    root?.setAttribute('inert', '')
    dialog.current?.focus()
    return () => { root?.removeAttribute('inert'); previous?.focus() }
  }, [])
  return (
    <div className="canvas-close-backdrop">
      <div ref={dialog} className="canvas-close-dialog" role="dialog" aria-modal="true" aria-labelledby="canvas-close-title" tabIndex={-1} onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Escape') { event.preventDefault(); onCancel() }
        if (event.key !== 'Tab') return
        const buttons = [...(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
        if (!buttons.length) { event.preventDefault(); return }
        const first = buttons[0]
        const last = buttons[buttons.length - 1]
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus() }
      }}>
        <h2 id="canvas-close-title">{phase === 'draft' ? '还有未完成的项目操作' : phase === 'confirm' ? '画布还有进行中的任务' : phase === 'waiting' ? '正在等待任务结束' : '正在保存画布'}</h2>
        {phase === 'draft' ? <p>尚未提交的项目名称或操作会被放弃，已保存的项目文件会继续保留。</p> : phase === 'confirm'
          ? <p>停止本地任务不会保证取消远端生成或退款。已提交的视频可凭任务记录继续查询。</p>
          : <p role="status"><LoaderCircle size={16} className="spin" aria-hidden="true" />{phase === 'waiting' ? '任务结束后保存项目并关闭。' : '项目保存成功后才会关闭窗口。'}</p>}
        <div className="canvas-close-actions">
          <button type="button" onClick={onCancel}><X size={15} aria-hidden="true" />返回画布</button>
          {phase === 'draft' && <button type="button" onClick={() => onChoose('stop')}>放弃未完成操作并关闭</button>}
          {phase === 'confirm' && <>
            <button type="button" onClick={() => onChoose('stop')}><Square size={14} aria-hidden="true" />停止本地任务并保存</button>
            <button type="button" onClick={() => onChoose('wait')}><Save size={15} aria-hidden="true" />等待完成后关闭</button>
          </>}
        </div>
      </div>
    </div>
  )
}

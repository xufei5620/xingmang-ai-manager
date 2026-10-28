import { useEffect, useLayoutEffect, useRef } from 'react'
import { isCanvasBrowserDraftSelected, selectCanvasBrowserDraft, type CanvasBrowserDraft, type CanvasBrowserDraftSelection } from './browser-draft'
import { focusCanvasDraftReturnControl } from './browser-draft-actions'
import './browser-draft-ui.css'

export function BrowserDraftRecovery({ drafts, cloudVersion, selected, mode = 'recovery', busy = false, blocked = false, listAvailable = true, confirmation, protectedSelection, returnFocus, storageError, notice, onSelect, onRestore, onUseCloud, onExport, onRequestRemove, onConfirmRemove, onCancelRemove, onClose, onRefresh }: {
  drafts: CanvasBrowserDraft[]
  cloudVersion: number
  selected: CanvasBrowserDraftSelection | null
  mode?: 'recovery' | 'manage'
  busy?: boolean
  blocked?: boolean
  listAvailable?: boolean
  confirmation?: CanvasBrowserDraft | null
  protectedSelection?: CanvasBrowserDraftSelection | null
  returnFocus?: HTMLElement | null
  storageError?: string | null
  notice?: string | null
  onSelect(selection: CanvasBrowserDraftSelection): void
  onRestore(): void
  onUseCloud(): void
  onExport(draft: CanvasBrowserDraft): void
  onRequestRemove(draft: CanvasBrowserDraft): void
  onConfirmRemove(): void
  onCancelRemove(): void
  onClose(): void
  onRefresh(): void
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const removeRef = useRef<HTMLButtonElement>(null)
  const hadConfirmationRef = useRef(false)
  const chosen = selectCanvasBrowserDraft(drafts, selected)
  const protectedDraft = Boolean(chosen && isCanvasBrowserDraftSelected(chosen, protectedSelection))
  useEffect(() => {
    const previous = returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    dialogRef.current?.focus()
    return () => { focusCanvasDraftReturnControl([previous, document.querySelector<HTMLButtonElement>('.canvas-toolbar [aria-label="更多操作"]')]) }
  }, [])
  useLayoutEffect(() => {
    if (confirmation) { hadConfirmationRef.current = true; cancelRef.current?.focus(); return }
    if (!hadConfirmationRef.current) return
    hadConfirmationRef.current = false
    focusCanvasDraftReturnControl([removeRef.current, dialogRef.current?.querySelector<HTMLInputElement>('input:checked:not(:disabled)') ?? null, dialogRef.current])
  }, [confirmation, busy])
  return <div className="canvas-project-dialog-backdrop">
    <div className="canvas-project-dialog canvas-draft-recovery" ref={dialogRef} role={confirmation ? 'alertdialog' : 'dialog'} aria-modal="true" aria-labelledby={confirmation ? 'canvas-draft-remove-title' : 'canvas-draft-title'} aria-describedby={confirmation ? 'canvas-draft-remove-description' : undefined} tabIndex={-1} onKeyDown={(event) => {
      event.stopPropagation()
      if (event.key === 'Escape') {
        event.preventDefault()
        if (confirmation && !busy) onCancelRemove()
        else if (mode === 'manage') onClose()
        return
      }
      if (event.key !== 'Tab') return
      const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? [])].filter((element) => element.getClientRects().length > 0)
      if (!controls.length) { event.preventDefault(); return }
      const first = controls[0]
      const last = controls[controls.length - 1]
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.current)) { event.preventDefault(); first.focus() }
    }}>
      <header><strong id="canvas-draft-title">{mode === 'manage' ? '管理本地草稿' : '发现未保存的本地草稿'}</strong></header>
      <p>{mode === 'manage' ? '以下是本浏览器为当前账户、当前工程保留的全部草稿。整理草稿不会替换当前画布或更改云端工程。' : '请选择要继续使用的内容。使用云端后，本地草稿仍会保留。'}</p>
      <fieldset className="canvas-draft-options" disabled={busy || Boolean(confirmation) || !listAvailable}>
        <legend>本地草稿</legend>
        {drafts.map((draft, index) => <label key={`${draft.writerId}:${draft.revision}`}>
          <input type="radio" name="canvas-draft" aria-label={`选择本地草稿 ${index + 1}`} checked={isCanvasBrowserDraftSelected(draft, selected)} onChange={() => onSelect({ writerId: draft.writerId, revision: draft.revision })} />
          <span>草稿 {index + 1} · {new Date(draft.updatedAt).toLocaleString('zh-CN')}<small>基于云端版本 {draft.cloudVersion}{draft.cloudVersion !== cloudVersion ? ' · 云端已有更新' : ''}{isCanvasBrowserDraftSelected(draft, protectedSelection) ? ' · 正在保护当前编辑' : ''}</small></span>
        </label>)}
        {!listAvailable ? <p>草稿列表尚未读取成功，请刷新核对。</p> : drafts.length === 0 && <p>本工程没有可读取的本地草稿。</p>}
      </fieldset>
      {mode === 'recovery' && chosen && chosen.cloudVersion !== cloudVersion && <p className="canvas-project-dialog-error">这份草稿对应较早的云端版本。恢复后自动保存会暂停，您可以另存为新工程。</p>}
      {storageError && <p className="canvas-project-dialog-error" role="alert">{storageError}</p>}
      {notice && <p className="canvas-draft-feedback" role="status">{notice}</p>}
      {blocked && <p className="canvas-project-dialog-error" role="alert">账户或工程已经变化，请关闭后重新进入工作区核对。</p>}
      {confirmation ? <section className="canvas-draft-confirmation">
        <strong id="canvas-draft-remove-title">删除这份本地草稿？</strong>
        <p id="canvas-draft-remove-description">仅删除本浏览器中这份草稿，无法撤销。当前画布和云端工程保持原样。请先导出需要保留的内容；导出不会自动删除草稿。</p>
        <p>保存时间：{new Date(confirmation.updatedAt).toLocaleString('zh-CN')} · 基于云端版本 {confirmation.cloudVersion}</p>
        <div><button type="button" ref={cancelRef} disabled={busy} onClick={onCancelRemove}>保留草稿</button><button type="button" className="is-destructive" disabled={busy || blocked} onClick={onConfirmRemove}>{busy ? '正在核对…' : '确认删除这份草稿'}</button></div>
      </section> : <>
        <div className="canvas-draft-actions">
          <button className="canvas-draft-export" type="button" disabled={!chosen || busy || !listAvailable} onClick={() => chosen && onExport(chosen)}>{busy ? '正在处理…' : '导出选中的本地草稿'}</button>
          {mode === 'manage' && <button type="button" ref={removeRef} disabled={!chosen || busy || blocked || protectedDraft || !listAvailable} onClick={() => chosen && onRequestRemove(chosen)}>删除选中的草稿</button>}
          {mode === 'manage' && <button type="button" disabled={busy || blocked} onClick={onRefresh}>刷新草稿列表</button>}
        </div>
        {protectedDraft && mode === 'manage' && <p className="canvas-draft-hint">这份草稿正在保护当前未保存编辑。请先完成保存，再决定是否清理。</p>}
      </>}
      <footer>
        {mode === 'manage' ? <button type="button" disabled={Boolean(confirmation) && busy} onClick={onClose}>关闭管理</button> : <>
          <button type="button" disabled={busy || blocked || Boolean(confirmation)} onClick={onUseCloud}>使用云端</button>
          <button type="button" className="is-primary" disabled={!chosen || busy || blocked || Boolean(confirmation)} onClick={onRestore}>恢复本地草稿</button>
        </>}
      </footer>
    </div>
  </div>
}

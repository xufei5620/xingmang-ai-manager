import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Bold, BookOpen, Braces, Code, Columns2, Copy, Download, FilePlus2, Heading1, Heading2, Heading3, Image, Italic, Link, List, ListOrdered, Minus, Pencil, Quote, Redo2, Save, Strikethrough, Type, Undo2, X } from 'lucide-react'
import { SafeMarkdownPreview } from './SafeMarkdownPreview'
import { maximumPromptPresetLength } from '../library/prompt-preset-contract'
import { canvasTextKeyIsComposing, canvasTextSelection, createCanvasTextHistory, formatCanvasText, maximumCanvasTextLength, rememberCanvasText, restoreCanvasText, type CanvasTextFormat, type CanvasTextHistory, type CanvasTextSelection } from './text-editor-state'
import './canvas-text-editor.css'

export interface CanvasTextEditorProps {
  title: string
  value: string
  readOnly?: boolean
  maxLength?: number
  notice?: string
  createTextDisabledReason?: string
  savePresetDisabledReason?: string
  onSave?(text: string, signal: AbortSignal): Promise<void>
  onCopy(text: string, signal: AbortSignal): Promise<void>
  /** Left out when the host blocks page downloads: the TXT button is not offered. */
  onDownload?(text: string, signal: AbortSignal): Promise<void>
  onCreateText?(text: string, signal: AbortSignal): Promise<void>
  onSavePreset?(text: string, signal: AbortSignal): Promise<void>
  onClose(): void
}
type ViewMode = 'preview' | 'edit' | 'split'
type Action = 'save' | 'copy' | 'download' | 'create' | 'preset'
const formats = [
  { id: 'bold', label: '粗体', icon: Bold, shortcut: '⌘/Ctrl+B' }, { id: 'italic', label: '斜体', icon: Italic, shortcut: '⌘/Ctrl+I' }, { id: 'strike', label: '删除线', icon: Strikethrough }, { id: 'inline-code', label: '行内代码', icon: Code },
  { id: 'h1', label: '一级标题', icon: Heading1 }, { id: 'h2', label: '二级标题', icon: Heading2 }, { id: 'h3', label: '三级标题', icon: Heading3 },
  { id: 'unordered', label: '无序列表', icon: List }, { id: 'ordered', label: '有序列表', icon: ListOrdered }, { id: 'quote', label: '引用', icon: Quote },
  { id: 'link', label: '链接', icon: Link, shortcut: '⌘/Ctrl+K' }, { id: 'image', label: '图片链接', icon: Image }, { id: 'code-block', label: '代码块', icon: Braces }, { id: 'divider', label: '分隔线', icon: Minus },
] as const

// The parent keys this dialog by its editing session. Prop echoes deliberately do
// not replace a draft; the parent also checks project/node scope before saving.
export function CanvasTextEditor({ title, value, readOnly = false, maxLength = maximumCanvasTextLength, notice, createTextDisabledReason, savePresetDisabledReason, onSave, onCopy, onDownload, onCreateText, onSavePreset, onClose }: CanvasTextEditorProps) {
  const initial = useRef(value), [history, setHistory] = useState(() => createCanvasTextHistory(value)), historyRef = useRef(history)
  const [mode, setMode] = useState<ViewMode>(readOnly ? 'preview' : 'split'), [error, setError] = useState(''), [status, setStatus] = useState('')
  const [busy, setBusy] = useState<Action | null>(null), [confirmClose, setConfirmClose] = useState(false)
  const panel = useRef<HTMLElement>(null), textarea = useRef<HTMLTextAreaElement>(null), confirmation = useRef<HTMLDivElement>(null)
  const composing = useRef<CanvasTextHistory | null>(null), operation = useRef<AbortController | null>(null), alive = useRef(true), selectionFrame = useRef<number | null>(null)
  const draft = history.present.text, dirty = !readOnly && draft !== initial.current, editable = !readOnly && !!onSave
  const presetDisabledReason = savePresetDisabledReason || (draft.length > maximumPromptPresetLength ? `提示词最多 ${maximumPromptPresetLength.toLocaleString('zh-CN')} 字符，正文不会截断；请先精简或${onDownload ? '下载' : '复制'}全文` : '')
  function change(next: CanvasTextHistory) { historyRef.current = next; setHistory(next); setError(''); setStatus('') }
  function select(next: CanvasTextSelection) {
    if (selectionFrame.current !== null) cancelAnimationFrame(selectionFrame.current)
    selectionFrame.current = requestAnimationFrame(() => { selectionFrame.current = null; if (alive.current && textarea.current) { textarea.current.focus(); textarea.current.setSelectionRange(next.start, next.end) } })
  }
  function selection(): CanvasTextSelection {
    const input = textarea.current, current = historyRef.current.present
    return input && input.value === current.text ? canvasTextSelection(current.text, input.selectionStart, input.selectionEnd) : current
  }
  function rememberSelection() {
    const current = historyRef.current, selected = selection()
    if (selected.start !== current.present.start || selected.end !== current.present.end) historyRef.current = { ...current, present: selected, typing: false }
  }
  function commit(next: CanvasTextSelection, typing = false) {
    if (next.text.length > maxLength) { setError(`文字超过 ${maxLength.toLocaleString('zh-CN')} 字符上限，未插入，请缩短后重试`); return }
    change(rememberCanvasText(historyRef.current, next, typing))
  }
  function format(action: CanvasTextFormat) {
    if (!editable || operation.current || composing.current) return
    try {
      const current = historyRef.current, selected = selection(), next = formatCanvasText(selected, action, maxLength)
      change(rememberCanvasText({ ...current, present: selected }, next)); select(next)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '文字格式操作失败，请重试') }
  }
  function undo(redo = false) {
    if (!editable || operation.current || composing.current) return
    const next = restoreCanvasText(historyRef.current, redo); change(next); select(next.present)
  }
  function close() { operation.current?.abort(); operation.current = null; onClose() }
  function requestClose() {
    if (!readOnly && historyRef.current.present.text !== initial.current) setConfirmClose(true)
    else close()
  }
  useEffect(() => {
    alive.current = true
    const previous = window.document.activeElement instanceof HTMLElement ? window.document.activeElement : null
    if (!readOnly) textarea.current?.focus()
    else panel.current?.focus()
    return () => { alive.current = false; operation.current?.abort(); if (selectionFrame.current !== null) cancelAnimationFrame(selectionFrame.current); if (previous?.isConnected) previous.focus() }
  }, [])
  useEffect(() => { if (confirmClose) confirmation.current?.querySelector<HTMLButtonElement>('button')?.focus() }, [confirmClose])
  async function run(action: Action) {
    if (operation.current || composing.current) return
    const text = historyRef.current.present.text
    if ((action === 'create' && createTextDisabledReason) || (action === 'preset' && (savePresetDisabledReason || text.length > maximumPromptPresetLength))) return
    const callback = action === 'save' ? (editable ? onSave : undefined) : action === 'copy' ? onCopy : action === 'download' ? onDownload : action === 'create' ? onCreateText : onSavePreset
    if (!callback || (action !== 'save' && !text.trim())) return
    if (action === 'save' && text.length > maxLength) { setError(`文字超过 ${maxLength.toLocaleString('zh-CN')} 字符上限，请先缩短文字`); return }
    const controller = new AbortController(); operation.current = controller; setBusy(action); setError(''); setStatus('')
    try {
      await callback(text, controller.signal)
      if (!alive.current || controller.signal.aborted || operation.current !== controller) return
      if (action === 'save') onClose()
      else setStatus(action === 'copy' ? '已复制全文' : action === 'download' ? '已下载 TXT' : action === 'create' ? '已另存为文本节点' : '已保存为提示词')
    } catch (cause) { if (alive.current && operation.current === controller && !controller.signal.aborted) { setConfirmClose(false); setError(cause instanceof Error ? cause.message : '文字操作失败，请重试') } }
    finally { if (operation.current === controller) { operation.current = null; if (alive.current) setBusy(null) } }
  }
  function keyDown(event: KeyboardEvent<HTMLElement>) {
    event.stopPropagation()
    if (canvasTextKeyIsComposing(event.nativeEvent) || composing.current) return
    if (event.key === 'Tab') {
      const scope = confirmClose ? confirmation.current : panel.current
      const focusable = scope?.querySelectorAll<HTMLElement>('button:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]')
      if (focusable?.length) {
        const first = focusable[0], last = focusable[focusable.length - 1]
        if (event.shiftKey && (window.document.activeElement === first || window.document.activeElement === scope)) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && (window.document.activeElement === last || window.document.activeElement === scope)) { event.preventDefault(); first.focus() }
      }
      return
    }
    if (event.key === 'Escape') { event.preventDefault(); if (confirmClose) { setConfirmClose(false); textarea.current?.focus() } else requestClose(); return }
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return
    const key = event.key.toLowerCase()
    if (confirmClose) { if (['z', 'y', 's', 'b', 'i', 'k'].includes(key)) event.preventDefault(); return }
    if (key === 'z' || key === 'y') { event.preventDefault(); undo(key === 'y' || event.shiftKey); return }
    if (key === 's') { event.preventDefault(); if (editable) void run('save'); return }
    if (editable && mode !== 'preview' && ['b', 'i', 'k'].includes(key)) { event.preventDefault(); format(key === 'b' ? 'bold' : key === 'i' ? 'italic' : 'link') }
  }
  return createPortal(<div className="canvas-text-backdrop nodrag nopan nowheel" onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
    <section className="canvas-text-editor" ref={panel} role="dialog" aria-modal="true" aria-label={readOnly ? '文字生成结果阅读器' : '文本编辑器'} tabIndex={-1} onKeyDown={keyDown}>
      <header className="canvas-text-header"><div className="canvas-text-title"><span className="canvas-text-title-icon"><Type size={20} /></span><div><h2>{title}</h2><p>{readOnly ? '生成结果 · 只读' : '编辑文字 · 保存后更新画布'}</p></div></div><button className="canvas-text-icon" onClick={requestClose} aria-label="关闭文本编辑器" title="关闭 · Esc"><X size={20} /></button></header>
      <div className="canvas-text-controls"><div className="canvas-text-modes" role="group" aria-label="文本显示方式">{([{ id: 'preview', label: '预览', icon: BookOpen }, { id: 'edit', label: readOnly ? '源码' : '编辑', icon: Pencil }, { id: 'split', label: '分屏', icon: Columns2 }] as const).map(({ id, label, icon: Icon }) => <button key={id} aria-pressed={mode === id} onClick={() => setMode(id)}><Icon size={15} />{label}</button>)}</div><div className="canvas-text-actions"><button onClick={() => void run('copy')} disabled={!!busy || !draft.trim()}><Copy size={15} />{busy === 'copy' ? '复制中…' : '复制全文'}</button>{onDownload && <button onClick={() => void run('download')} disabled={!!busy || !draft.trim()}><Download size={15} />{busy === 'download' ? '下载中…' : '下载 TXT'}</button>}</div></div>
      {notice && <p className="canvas-text-notice" role="note">{notice}</p>}
      {editable && mode !== 'preview' && <div className="canvas-text-formatbar" role="toolbar" aria-label="Markdown 格式"><button className="canvas-text-icon" title="撤销 · ⌘/Ctrl+Z" aria-label="撤销文字编辑" disabled={!!busy || !history.past.length} onPointerDown={(event) => event.preventDefault()} onClick={() => undo()}><Undo2 size={16} /></button><button className="canvas-text-icon" title="重做 · ⌘/Ctrl+Shift+Z" aria-label="重做文字编辑" disabled={!!busy || !history.future.length} onPointerDown={(event) => event.preventDefault()} onClick={() => undo(true)}><Redo2 size={16} /></button><span className="canvas-text-format-divider" />{formats.map(({ id, label, icon: Icon, ...rest }) => <button key={id} className="canvas-text-icon" title={`${label}${'shortcut' in rest ? ` · ${rest.shortcut}` : ''}`} aria-label={label} disabled={!!busy} onPointerDown={(event) => event.preventDefault()} onClick={() => format(id)}><Icon size={16} /></button>)}</div>}
      <div className={`canvas-text-workspace is-${mode}`}>
        {mode !== 'preview' && <div className="canvas-text-source"><div className="canvas-text-pane-heading">{readOnly ? 'Markdown 源码 · 只读' : 'Markdown 编辑'}<span>纯文本</span></div><textarea ref={textarea} aria-label={readOnly ? '生成结果全文源码' : '文本编辑内容'} value={draft} readOnly={!editable || !!busy} spellCheck={false} placeholder="写下你的想法，也可以使用 Markdown 排版…" onSelect={rememberSelection} onBeforeInput={rememberSelection} onCompositionStart={() => { if (editable) { rememberSelection(); composing.current = historyRef.current } }} onCompositionEnd={(event) => {
          const before = composing.current; composing.current = null
          if (before) { const next = canvasTextSelection(event.currentTarget.value, event.currentTarget.selectionStart, event.currentTarget.selectionEnd); if (next.text.length <= maxLength) change(rememberCanvasText(before, next)); else { change(before); setError(`文字超过 ${maxLength.toLocaleString('zh-CN')} 字符上限，本次输入未保存`) } }
        }} onChange={(event) => {
          if (!editable || operation.current) return
          const next = canvasTextSelection(event.currentTarget.value, event.currentTarget.selectionStart, event.currentTarget.selectionEnd)
          if (composing.current) { const updated = { ...historyRef.current, present: next }; historyRef.current = updated; setHistory(updated) }
          else commit(next, true)
        }} onPaste={(event) => {
          if (!editable || operation.current || composing.current) return
          event.preventDefault(); const selected = selection(), pasted = event.clipboardData.getData('text/plain')
          const next = canvasTextSelection(selected.text.slice(0, selected.start) + pasted + selected.text.slice(selected.end), selected.start + pasted.length)
          if (next.text.length > maxLength) { setError(`粘贴后超过 ${maxLength.toLocaleString('zh-CN')} 字符上限，未插入，请缩短后重试`); return }
          change(rememberCanvasText({ ...historyRef.current, present: selected }, next)); select(next)
        }} /></div>}
        {mode !== 'edit' && <div className="canvas-text-preview"><div className="canvas-text-pane-heading">排版预览<span>图片不会自动加载</span></div><div className="canvas-text-preview-scroll" tabIndex={0} aria-label="Markdown 排版预览"><SafeMarkdownPreview value={draft} downloadable={!!onDownload} /></div></div>}
      </div>
      <div className="canvas-text-feedback">{error ? <p role="alert">{error}</p> : <p role="status">{status || (dirty ? '有未保存的修改' : readOnly ? '原始生成内容保留在节点中' : '保存前不会修改画布节点')}</p>}<span>{draft.length.toLocaleString('zh-CN')}{editable ? ` / ${maxLength.toLocaleString('zh-CN')}` : ''} 字符</span></div>
      {onSavePreset && draft.length > maximumPromptPresetLength && <p className="canvas-text-preset-limit" role="note">提示词上限 24,000 字符；当前全文可{onDownload ? '复制、下载' : '复制'}或另存文本节点，不会截断。</p>}
      <footer className="canvas-text-footer"><div className="canvas-text-secondary">{onCreateText && <button disabled={!!busy || !draft.trim() || !!createTextDisabledReason} title={createTextDisabledReason || '创建可独立编辑的文本节点'} onClick={() => void run('create')}><FilePlus2 size={16} />{busy === 'create' ? '另存中…' : '另存文本节点'}</button>}{onSavePreset && <button disabled={!!busy || !draft.trim() || !!presetDisabledReason} title={presetDisabledReason || '将全文保存到个人提示词'} onClick={() => void run('preset')}><BookOpen size={16} />{busy === 'preset' ? '保存中…' : '存为提示词'}</button>}</div><div className="canvas-text-primary"><button onClick={requestClose}>{readOnly ? '关闭' : '取消'}</button>{editable && <button className="is-primary" onClick={() => void run('save')} disabled={!!busy || !dirty}><Save size={16} />{busy === 'save' ? '保存中…' : '保存并关闭'}</button>}</div></footer>
      {confirmClose && <div className="canvas-text-confirm-backdrop"><div ref={confirmation} className="canvas-text-confirm" role="alertdialog" aria-modal="true" aria-labelledby="canvas-text-confirm-title" aria-describedby="canvas-text-confirm-detail"><h3 id="canvas-text-confirm-title">保留这次修改？</h3><p id="canvas-text-confirm-detail">文字尚未保存。你可以继续编辑，或保存后关闭。</p><div><button onClick={() => { setConfirmClose(false); textarea.current?.focus() }}>继续编辑</button><button onClick={close}>放弃修改</button><button className="is-primary" disabled={!!busy} onClick={() => void run('save')}>{busy === 'save' ? '保存中…' : '保存并关闭'}</button></div></div></div>}
    </section>
  </div>, window.document.body)
}

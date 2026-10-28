import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Check, Pencil, X } from 'lucide-react'
import '../theme/project-name.css'

export function CanvasProjectName({ name, disabled, onRename }: { name: string; disabled?: boolean; onRename(name: string): Promise<void> }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const saving = useRef(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (saving.current || disabled) return
    const next = draft.trim()
    if (!next || next.length > 256 || /[\u0000-\u001f\u007f]/.test(next)) { setError('请输入 1–256 个字符的项目名称，不含控制字符'); return }
    if (next === name) { setEditing(false); return }
    saving.current = true; setBusy(true); setError(null)
    try { await onRename(next); if (alive.current) setEditing(false) }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : '项目改名未确认，请核对后重试') }
    finally { saving.current = false; if (alive.current) setBusy(false) }
  }
  if (!editing) return <button className="canvas-project-name" type="button" disabled={disabled} title={`重命名项目：${name}`} aria-label={`重命名项目：${name}`} onClick={() => { setDraft(name); setError(null); setEditing(true) }}><strong>{name}</strong><Pencil size={12} /></button>
  return <form className="canvas-project-name-form" onSubmit={(event) => { void submit(event) }} onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Escape' && !busy) { event.preventDefault(); setEditing(false) } }} aria-busy={busy}>
    <input aria-label="项目名称" value={draft} maxLength={256} autoFocus onFocus={(event) => event.target.select()} disabled={busy} onChange={(event) => setDraft(event.target.value)} />
    <button type="submit" aria-label="保存项目名称" title={busy ? '正在保存项目名称…' : '保存项目名称'} disabled={busy || disabled || !draft.trim()}><Check size={14} /></button>
    <button type="button" aria-label="取消项目改名" title="取消改名" disabled={busy} onClick={() => setEditing(false)}><X size={14} /></button>
    {error && <p role="alert">{error}</p>}
  </form>
}

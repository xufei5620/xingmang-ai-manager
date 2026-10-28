import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { ArrowDown, ArrowUp, Check, LoaderCircle, Pencil, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react'
import { buildPromptPresetMove, maximumPromptPresetLength, promptPresetGroups, sortPromptPresets, type CanvasPromptPreset } from '../library/prompt-preset-contract'
import { usePromptCatalogValue } from './PromptCatalogContext'
import { promptShortcutComposing, promptShortcutMenuHandlesKeys, type PromptShortcut, type PromptShortcutSource } from './prompt-shortcuts'
import { positionPromptMenu, type PromptMenuPosition } from './prompt-menu-position'
import { PromptPresetMetadataFields } from './PromptPresetMetadataFields'
import { PromptPresetRecovery } from './PromptPresetRecovery'
import { promptPresetSaveFailure } from '../library/prompt-preset-recovery'
import { workshopItemPermissions } from '../lib/workshop-transfer-contract'
import './prompt-shortcuts.css'

export interface PromptShortcutMenuProps {
  id: string
  anchorRef?: RefObject<HTMLTextAreaElement | null>
  items: readonly PromptShortcut[]
  total: number
  query: string
  source: PromptShortcutSource
  group?: string | null
  onGroup?(value: string | null): void
  activeIndex: number
  draft: string
  error: string | null
  onQuery(value: string): void
  onSource(value: PromptShortcutSource): void
  onActive(index: number): void
  onInsert(item: PromptShortcut): void
  onClose(): void
  onKeyDown(event: KeyboardEvent<HTMLElement>): void
}

export function PromptShortcutMenu(props: PromptShortcutMenuProps) {
  const catalog = usePromptCatalogValue()
  const list = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const verify = useRef<HTMLButtonElement>(null)
  const pendingFocus = useRef<'search' | 'verify' | null>(null)
  const [position, setPosition] = useState<PromptMenuPosition | null>(null)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [group, setGroup] = useState('')
  const [description, setDescription] = useState('')
  const [editing, setEditing] = useState<CanvasPromptPreset | null>(null)
  const [deleting, setDeleting] = useState<CanvasPromptPreset | null>(null)
  const [actionUncertain, setActionUncertain] = useState(false)
  const [editReadRequested, setEditReadRequested] = useState(false)
  const [busy, setBusy] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [conflict, setConflict] = useState(false)
  const recovering = uncertain || conflict
  const [saveError, setSaveError] = useState<string | null>(null)
  const lifetime = useRef({ active: true, saving: false })
  useEffect(() => { lifetime.current.active = true; return () => { lifetime.current.active = false } }, [])
  useLayoutEffect(() => {
    const target = pendingFocus.current === 'search' ? search.current : pendingFocus.current === 'verify' ? verify.current : null
    if (!target || target.disabled) return
    pendingFocus.current = null
    target.focus({ preventScroll: true })
  })
  useLayoutEffect(() => {
    const anchor = props.anchorRef?.current, panel = menu.current
    if (!anchor || !panel) return
    let frame: number | null = null
    function measure() {
      frame = null
      if (!anchor || !panel) return
      const viewport = window.visualViewport
      const next = positionPromptMenu(anchor.getBoundingClientRect(), { left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0, width: viewport?.width ?? window.innerWidth, height: viewport?.height ?? window.innerHeight }, panel.getBoundingClientRect().height || 430)
      setPosition((current) => current && current.left === next.left && current.top === next.top && current.width === next.width && current.maxHeight === next.maxHeight && current.side === next.side ? current : next)
    }
    function schedule() { if (frame === null) frame = requestAnimationFrame(measure) }
    measure()
    const sizes = new ResizeObserver(schedule)
    sizes.observe(anchor); sizes.observe(panel)
    // CSS transforms emit neither resize nor scroll. Observe both XYFlow
    // transform owners to follow node movement and viewport pan/zoom.
    const transforms = new MutationObserver(schedule)
    for (const selector of ['.react-flow__node', '.react-flow__viewport']) {
      const owner = anchor.closest(selector)
      if (owner) transforms.observe(owner, { attributes: true, attributeFilter: ['style', 'class'] })
    }
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    window.visualViewport?.addEventListener('resize', schedule)
    window.visualViewport?.addEventListener('scroll', schedule)
    return () => {
      if (frame !== null) cancelAnimationFrame(frame)
      sizes.disconnect(); transforms.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      window.visualViewport?.removeEventListener('resize', schedule)
      window.visualViewport?.removeEventListener('scroll', schedule)
    }
  }, [props.anchorRef])
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' }) }, [props.activeIndex])
  const match = recovering ? catalog.items.find((item) => (!editing || item.id === editing.id) && item.name === name.trim() && item.prompt === prompt && (item.group ?? '') === group.trim() && (item.description ?? '') === description.trim()) : undefined
  const latestEdit = editing ? catalog.items.find((item) => item.id === editing.id) : undefined
  const groups = useMemo(() => promptPresetGroups(catalog.items), [catalog.items])
  const movementItems = useMemo(() => sortPromptPresets(catalog.items).filter((item) => props.group == null || (item.group ?? '') === props.group), [catalog.items, props.group])
  const movementIndexes = useMemo(() => new Map(movementItems.map((item, index) => [item.id, index])), [movementItems])
  function beginEdit(item?: CanvasPromptPreset) { if (item && !workshopItemPermissions(item).canEdit) { setSaveError('此分享条目仅使用，不能编辑工坊原配置；插入画布后可调整独立副本。'); return } setCreating(true); setEditing(item ?? null); setName(item?.name ?? ''); setPrompt(item?.prompt ?? (props.draft.length <= maximumPromptPresetLength ? props.draft : '')); setGroup(item?.group ?? props.group ?? ''); setDescription(item?.description ?? ''); setSaveError(null); setUncertain(false); setConflict(false); setEditReadRequested(false); setDeleting(null) }
  async function action(operation: () => Promise<void>) {
    if (lifetime.current.saving || actionUncertain) return
    lifetime.current.saving = true; menu.current?.focus({ preventScroll: true }); setBusy(true); setSaveError(null)
    try { await operation(); if (lifetime.current.active) setDeleting(null) }
    catch (error) { if (lifetime.current.active) { setActionUncertain(true); setSaveError(error instanceof Error ? error.message : '操作回执未确认，请刷新核对。') } }
    finally { lifetime.current.saving = false; if (lifetime.current.active) setBusy(false) }
  }
  function refresh() { setEditReadRequested(true); void catalog.load(true).then(() => { if (lifetime.current.active) setActionUncertain(false) }) }
  async function save() {
    if (lifetime.current.saving || recovering || (editing && !workshopItemPermissions(editing).canEdit) || !catalog.enabled || (!editing && !catalog.create) || (editing && !catalog.update) || !name.trim() || !prompt.trim()) return
    lifetime.current.saving = true
    // Keep focus on a stable portal element while inputs become disabled and
    // the successful form is replaced. Neither transition is an outside click.
    menu.current?.focus({ preventScroll: true })
    setBusy(true); setSaveError(null); setEditReadRequested(false)
    try {
      const fields = { name: name.trim(), prompt, group: group.trim(), description: description.trim() }
      if (editing && catalog.update) await catalog.update({ id: editing.id, expectedVersion: editing.version ?? 1, ...fields })
      else if (catalog.create) await catalog.create(fields)
      if (lifetime.current.active) { pendingFocus.current = 'search'; setCreating(false); props.onSource(editing?.origin || editing?.transferOrigin ? 'acquired' : 'mine'); props.onGroup?.(group.trim()); props.onQuery(name.trim()) }
    } catch (error) {
      if (lifetime.current.active) { const result = promptPresetSaveFailure(error, Boolean(editing)); pendingFocus.current = result.kind === 'rejected' ? null : 'verify'; setUncertain(result.kind === 'uncertain'); setConflict(result.kind === 'conflict'); setSaveError(result.message) }
    } finally { lifetime.current.saving = false; if (lifetime.current.active) setBusy(false) }
  }
  const content = <section ref={menu} tabIndex={-1} data-prompt-shortcut-owner={props.id} data-placement={position?.side} style={position ? { left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight } : undefined} className="wf-shortcut-menu nodrag nowheel" aria-label="提示词预设快捷调用" aria-busy={busy} onKeyDown={(event) => { if (event.key === 'Escape' && !promptShortcutComposing(event.nativeEvent) && !busy) { event.preventDefault(); props.onClose(); event.stopPropagation(); return } if (!creating && event.target instanceof HTMLElement && promptShortcutMenuHandlesKeys({ search: event.target.hasAttribute('data-prompt-shortcut-search'), role: event.target.getAttribute('role') })) props.onKeyDown(event); event.stopPropagation() }}>
    <header><strong># 提示词预设</strong><button type="button" aria-label="关闭提示词预设" disabled={busy} onClick={props.onClose}><X size={14} /></button></header>
    {creating ? <form className="wf-shortcut-create" onSubmit={(event) => { event.preventDefault(); void save() }}>
      <label>模板名称<input autoFocus value={name} maxLength={catalog.nameMaxLength ?? 160} disabled={busy} onChange={(event) => setName(event.target.value)} /></label>
      {catalog.metadata !== false && <PromptPresetMetadataFields group={group} description={description} groups={groups} disabled={busy} onGroup={setGroup} onDescription={setDescription} />}
      <label>提示词正文<textarea value={prompt} maxLength={maximumPromptPresetLength} rows={5} disabled={busy} onChange={(event) => setPrompt(event.target.value)} /></label>
      <small>{editing ? '编辑我的模板，已插入画布的正文不受影响。' : '保存在当前账户；选用时插入完整正文。'}</small>
      {saveError && <p role="alert">{saveError}</p>}
      {recovering && catalog.error && <p role="alert">{catalog.error}</p>}
      {recovering && <PromptPresetRecovery readButtonRef={verify} conflict={conflict} editing={Boolean(editing)} latest={latestEdit ?? match ?? null} matched={Boolean(match)} readComplete={editReadRequested && !catalog.loading && !catalog.error} loading={catalog.loading} onRead={refresh} onKeep={() => { if (!latestEdit) return; setEditing(latestEdit); setUncertain(false); setConflict(false); setEditReadRequested(false); setSaveError(null) }} onReload={() => { const saved = latestEdit ?? match; if (saved) beginEdit(saved) }} />}
      <footer><button type="button" disabled={busy} onClick={() => { pendingFocus.current = 'search'; if (match) { props.onSource(match.origin || match.transferOrigin ? 'acquired' : 'mine'); props.onGroup?.(group.trim()); props.onQuery(name.trim()) } setCreating(false); setUncertain(false); setConflict(false) }}>返回列表</button><button type="submit" disabled={busy || recovering || !name.trim() || !prompt.trim()}>{busy ? <LoaderCircle size={13} /> : <Check size={13} />}保存</button></footer>
    </form> : <>
      <div className="wf-shortcut-source" role="group" aria-label="提示词来源">{([['all', '全部'], ['builtin', '官方原创'], ['mine', '我的'], ['acquired', '已获取']] as const).map(([source, label]) => <button key={source} type="button" aria-pressed={props.source === source} onClick={() => props.onSource(source)}>{label}</button>)}<button type="button" aria-label="刷新我的提示词" title="刷新我的提示词" disabled={catalog.loading || !catalog.enabled} onClick={refresh}><RefreshCw size={13} /></button></div>
      <label className="wf-shortcut-group">分组<select aria-label="提示词分组筛选" value={props.group == null ? "all" : JSON.stringify(props.group)} disabled={busy} onChange={(event) => props.onGroup?.(event.target.value === "all" ? null : JSON.parse(event.target.value))}><option value="all">全部分组</option><option value={JSON.stringify('')}>未分组</option>{groups.map((item) => <option key={item} value={JSON.stringify(item)}>{item}</option>)}{props.group && !groups.includes(props.group) && <option value={JSON.stringify(props.group)}>{props.group}</option>}</select></label>
      <label className="wf-shortcut-search"><Search size={14} /><input ref={search} data-prompt-shortcut-search="true" aria-label="搜索提示词预设" role="combobox" aria-expanded="true" aria-autocomplete="list" placeholder="搜索名称、分组、简介、标签…" value={props.query} onChange={(event) => props.onQuery(event.target.value)} aria-controls={props.id} aria-activedescendant={props.items[props.activeIndex] ? `${props.id}-${props.activeIndex}` : undefined} /></label>
      {catalog.loading && <p role="status">正在读取我的提示词…</p>}
      {catalog.error && <p role="alert">{catalog.error} <button type="button" onClick={refresh}>重试</button></p>}
      {props.error && <p role="alert">{props.error}</p>}{saveError && <p role="alert">{saveError}</p>}
      {deleting && <div className="wf-shortcut-delete" role="group" aria-label="删除提示词确认"><p>删除“{deleting.name}”？画布中已插入的正文不会改变。</p><button disabled={busy || actionUncertain} onClick={() => void action(() => catalog.remove!(deleting.id, deleting.version ?? 1))}>确认删除</button><button disabled={busy} onClick={() => setDeleting(null)}>取消</button></div>}
      <div ref={list} id={props.id} className="wf-shortcut-options" role="listbox" aria-label="可用提示词预设">{props.items.map((item, index) => {
        const personal = item.source !== 'builtin' ? catalog.items.find((entry) => `mine:${entry.id}` === item.id) : undefined
        const movable = personal && catalog.reorder && !props.query.trim() && !busy && !actionUncertain && !catalog.loading && !catalog.error
        return <div key={item.id} className="wf-shortcut-row" role="presentation"><button id={`${props.id}-${index}`} type="button" role="option" aria-selected={index === props.activeIndex} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => props.onActive(index)} onClick={() => props.onInsert(item)}><span><strong>{item.name}</strong><small>{item.description || item.prompt}</small></span><em>{item.source === 'acquired' ? item.originLabel || `社区 · ${item.authorName || '创作者'}` : item.source === 'mine' ? item.group || '未分组' : '官方原创'}</em></button>{personal && <span className="wf-shortcut-row-actions" role="group" aria-label={`管理提示词 ${item.name}`}>{(['up', 'down'] as const).map((direction) => { const movementIndex = movementIndexes.get(personal.id) ?? -1; const canMove = direction === 'up' ? movementIndex > 0 : movementIndex >= 0 && movementIndex < movementItems.length - 1; return <button key={direction} type="button" aria-label={`${direction === 'up' ? '上移' : '下移'}提示词 ${item.name}`} title={props.query.trim() ? '清空搜索后可调整完整分组顺序' : direction === 'up' ? '上移' : '下移'} disabled={!movable || !canMove} onClick={() => { const move = buildPromptPresetMove(catalog.items, personal.id, direction, props.group ?? null); if (move) void action(() => catalog.reorder!(move)) }}>{direction === 'up' ? <ArrowUp size={12} /> : <ArrowDown size={12} />}</button> })}{catalog.update && <button type="button" aria-label={`编辑提示词 ${item.name}`} title={!workshopItemPermissions(personal).canEdit ? '此条目仅使用，不能编辑工坊原配置' : '编辑提示词'} disabled={busy || !workshopItemPermissions(personal).canEdit} onClick={() => beginEdit(personal)}><Pencil size={12} /></button>}{catalog.remove && <button type="button" aria-label={`删除提示词 ${item.name}`} disabled={busy} onClick={() => setDeleting(personal)}><Trash2 size={12} /></button>}</span>}</div>
      })}{!props.items.length && <p>没有匹配的提示词，试试其他关键词。</p>}</div>
      <footer><small>↑↓ 选择 · Enter 插入 · Esc 保留 #</small>{catalog.create && <button type="button" disabled={!catalog.enabled || busy} onClick={() => beginEdit()}><Plus size={13} />我的模板</button>}</footer>
      <p className="wf-shortcut-note">{props.total > props.items.length ? `匹配 ${props.total} 条，先显示前 ${props.items.length} 条，可缩小搜索范围。` : '官方以整体标签插入；我的和已获取插入完整正文。保存后不依赖原模板。'}</p>
    </>}
  </section>
  return typeof document === 'undefined' ? content : createPortal(content, document.body)
}

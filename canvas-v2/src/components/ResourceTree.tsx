import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Check, ChevronDown, ChevronRight, Download, Group, ListChecks, Lock, LockOpen, MoreHorizontal, Pencil, Search, X } from 'lucide-react'
import { buildResourceTree, resourceGroupSelectionIds, resourceSelectionIds, type ResourceNode } from './resource-tree-model'
import { NodeTypeIcon } from './NodeTypeIcon'
import { ResourceTreeMenu } from './ResourceTreeMenu'
import '../theme/resource-tree.css'

export interface ResourceTreeProps {
  readOnly?: boolean
  nodes: readonly ResourceNode[]
  onSelect(ids: string[], focusId?: string): void
  onRename(id: string): void
  onGroup(ids: string[]): void
  onLock(ids: string[], locked: boolean): void
  onExport(ids: string[]): void
  canExport: boolean
}

export function ResourceTree({ readOnly, nodes, onSelect, onRename, onGroup, onLock, onExport, canExport }: ResourceTreeProps) {
  const [query, setQuery] = useState('')
  const [type, setType] = useState('')
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [multiple, setMultiple] = useState(false)
  const [menu, setMenu] = useState<string | null>(null)
  const anchor = useRef<string | null>(null)
  const menuTrigger = useRef<HTMLButtonElement | null>(null)
  const menuEdge = useRef<'first' | 'last'>('first')
  const tree = useMemo(() => buildResourceTree(nodes, query, type, collapsed), [nodes, query, type, collapsed])
  const types = useMemo(() => [...new Map(buildResourceTree(nodes).rows.map((row) => [row.type, row.typeTitle])).entries()], [nodes])
  const selected = nodes.filter((node) => node.selected).map((node) => node.id)
  const groupable = resourceGroupSelectionIds(nodes, selected)
  const locked = selected.length > 0 && nodes.filter((node) => node.selected).every((node) => node.draggable === false)
  function closeMenu(restoreFocus = true) {
    setMenu(null)
    if (restoreFocus && menuTrigger.current?.isConnected) menuTrigger.current.focus({ preventScroll: true })
  }
  useEffect(() => {
    if (menu && !tree.rows.some((row) => row.id === menu)) closeMenu(false)
  }, [menu, tree.rows])
  function openMenu(id: string, trigger: HTMLButtonElement, edge: 'first' | 'last' = 'first') {
    menuTrigger.current = trigger
    menuEdge.current = edge
    setMenu(id)
  }
  function triggerKey(event: KeyboardEvent<HTMLButtonElement>, id: string) {
    event.stopPropagation()
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape' && menu === id) { event.preventDefault(); closeMenu(); return }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      openMenu(id, event.currentTarget, event.key === 'ArrowUp' ? 'last' : 'first')
    }
  }
  function select(id: string, toggle: boolean, range: boolean) {
    const next = resourceSelectionIds(selected, tree.rows.map((row) => row.id), id, { toggle: toggle || multiple, range, anchor: anchor.current })
    if (!range) anchor.current = id
    onSelect(next, !multiple && !toggle && !range ? id : undefined)
  }
  function toggleGroup(id: string) {
    setCollapsed((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next })
  }
  return <section className="resource-tree" aria-label="画布资源管理" onKeyDown={(event) => event.stopPropagation()}>
    <header><div><strong>资源管理</strong><small>{nodes.length} 个节点 · 顶层 {tree.topLevelCount} 项</small></div><button type="button" className={multiple ? 'is-active' : ''} aria-pressed={multiple} title={multiple ? '退出多选' : '多选资源'} aria-label={multiple ? '退出多选' : '多选资源'} onClick={() => setMultiple((value) => !value)}><ListChecks size={17} /></button></header>
    <div className="resource-tree-filters">
      <label><Search size={14} /><input aria-label="搜索资源名称或节点 ID" placeholder="搜索名称或 ID" value={query} onChange={(event) => setQuery(event.target.value)} />{query && <button type="button" aria-label="清空资源搜索" onClick={() => setQuery('')}><X size={13} /></button>}</label>
      <select aria-label="筛选资源类型" value={type} onChange={(event) => setType(event.target.value)}><option value="">全部类型</option>{types.map(([id, title]) => <option key={id} value={id}>{title}</option>)}</select>
    </div>
    {(selected.length > 0 || multiple) && <div className="resource-tree-selection"><span>已选 {selected.length} 项</span><button type="button" disabled={!selected.length} onClick={() => onSelect([])}>清空</button><div>
      <button type="button" disabled={readOnly || !groupable.length} title={groupable.length ? '将同级资源编为一组，可撤销' : '请选择至少两个同级资源；已选组包含其子项'} onClick={() => onGroup(groupable)}><Group size={13} />编组</button>
      {canExport && <button type="button" disabled={!selected.length} title="打包选中节点、整组子项与内部连线，预检后携带可用的图片、视频与音频" onClick={() => onExport(selected)}><Download size={13} />打包</button>}
      <button type="button" disabled={readOnly || !selected.length} title={locked ? '解锁所选节点位置' : '锁定所选节点位置'} aria-label={locked ? '解锁所选节点位置' : '锁定所选节点位置'} onClick={() => onLock(selected, !locked)}>{locked ? <LockOpen size={13} /> : <Lock size={13} />}</button>
    </div></div>}
    <div className="resource-tree-list" role="tree" aria-label="画布节点树" aria-multiselectable="true">
      {tree.rows.map((row) => <div key={row.id} className={`resource-tree-entry${row.selected ? ' is-selected' : ''}${row.matches ? '' : ' is-ancestor'}`} role="treeitem" aria-level={row.depth + 1} aria-selected={row.selected} aria-expanded={row.childCount ? row.expanded : undefined}>
        <div className="resource-tree-row" style={{ paddingLeft: 6 + Math.min(row.depth, 8) * 13 }}>
          {row.childCount ? <button type="button" className="resource-tree-disclosure" disabled={Boolean(query.trim() || type)} title={row.expanded ? `折叠 ${row.title}` : `展开 ${row.title}`} aria-label={row.expanded ? `折叠 ${row.title}` : `展开 ${row.title}`} onClick={() => toggleGroup(row.id)}>{row.expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button> : <span className="resource-tree-disclosure" />}
          {multiple && <button type="button" className="resource-tree-check" role="checkbox" aria-checked={row.selected} aria-label={`选择 ${row.title}`} onClick={(event) => select(row.id, true, event.shiftKey)}>{row.selected && <Check size={11} />}</button>}
          <button type="button" className="resource-tree-target" title={`${row.title}\n${row.id}\n${multiple ? '点击切换选择' : '点击定位；⌘/Ctrl 多选，Shift 连选'}`} onClick={(event) => select(row.id, event.metaKey || event.ctrlKey, event.shiftKey)} onDoubleClick={() => { if (!readOnly) onRename(row.id) }}>
            <span className="resource-tree-kind"><NodeTypeIcon type={row.type} category={row.category} size={14} /></span><span><strong>{row.title}</strong><small>{row.typeTitle}{row.childCount ? ` · ${row.childCount} 子项` : ''}</small></span>{row.locked && <Lock size={11} className="resource-tree-lock" aria-label="位置已锁定" />}
          </button>
          <button type="button" className="resource-tree-more" aria-label={`${row.title}的资源操作`} aria-haspopup="menu" aria-controls={menu === row.id ? `resource-actions-${encodeURIComponent(row.id)}` : undefined} aria-expanded={menu === row.id} onKeyDown={(event) => triggerKey(event, row.id)} onClick={(event) => { if (menu === row.id) closeMenu(); else openMenu(row.id, event.currentTarget) }}><MoreHorizontal size={15} /></button>
        </div>
        {menu === row.id && <ResourceTreeMenu key={row.id} id={`resource-actions-${encodeURIComponent(row.id)}`} title={row.title} triggerRef={menuTrigger} focusEdge={menuEdge.current} onClose={closeMenu}>
          <button type="button" role="menuitem" disabled={readOnly} onClick={() => { closeMenu(); onRename(row.id) }}><Pencil size={12} />重命名</button>
          {canExport && <button type="button" role="menuitem" onClick={() => { closeMenu(); onExport([row.id]) }}><Download size={12} />打包导出</button>}
          <button type="button" role="menuitem" disabled={readOnly} onClick={() => { closeMenu(); onLock([row.id], !row.locked) }}>{row.locked ? <LockOpen size={12} /> : <Lock size={12} />}{row.locked ? '解锁位置' : '锁定位置'}</button>
        </ResourceTreeMenu>}
      </div>)}
      {!tree.rows.length && <p className="resource-tree-empty">{nodes.length ? '没有匹配资源，试试名称或节点 ID。' : '画布还没有节点。打开节点库，开始创作。'}</p>}
    </div>
    <footer>{readOnly ? '只读浏览 · 可定位、预览和导出' : query.trim() || type ? `匹配 ${tree.matches} 项 · 保留所属分组` : '折叠只影响列表 · 改名、编组和锁定支持撤销'}</footer>
  </section>
}

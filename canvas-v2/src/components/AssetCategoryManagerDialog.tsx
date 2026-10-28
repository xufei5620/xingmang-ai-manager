import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { AssetCategoryDirectory, AssetCategorySummary } from '../lib/asset-category-contract'
import { maximumAssetCategories, maximumAssetCategoryNameLength } from '../lib/asset-category-contract'
import { AssetCategoryDialogFrame } from './AssetCategoryDialogFrame'
import { useAssetCategoryOperation, type AssetCategoryOperationProps } from './asset-category-operation'

export interface AssetCategoryManagerDialogProps extends AssetCategoryOperationProps {
  directory: AssetCategoryDirectory | null
  onReadDirectory(signal?: AbortSignal): Promise<AssetCategoryDirectory>
  onClose(): void
}

export function AssetCategoryManagerDialog(props: AssetCategoryManagerDialogProps) {
  const [directory, setDirectory] = useState(props.directory)
  const [editing, setEditing] = useState<'new' | AssetCategorySummary | null>(null)
  const [name, setName] = useState('')
  const [deleting, setDeleting] = useState<AssetCategorySummary | null>(null)
  const [reading, setReading] = useState(false)
  const [readError, setReadError] = useState('')
  const [latest, setLatest] = useState<AssetCategorySummary | null | undefined>(undefined)
  const guard = useRef({ scope: props.scopeKey, generation: 0, mounted: true })
  const controller = useRef<AbortController | null>(null)
  if (guard.current.scope !== props.scopeKey) { guard.current.scope = props.scopeKey; guard.current.generation++; controller.current?.abort() }
  const operation = useAssetCategoryOperation({ ...props, onChanged(result) { if (result.action !== 'move') { setEditing(null); setDeleting(null); setName(''); setLatest(undefined) }; props.onChanged(result) } })
  useEffect(() => { setDirectory(props.directory) }, [props.directory])
  useEffect(() => { guard.current.mounted = true; return () => { guard.current.mounted = false; guard.current.generation++; controller.current?.abort() } }, [])
  async function readDirectory() {
    if (reading || operation.busy || props.disabled) return
    const active = new AbortController(), generation = ++guard.current.generation
    controller.current?.abort(); controller.current = active; setReading(true); setReadError('')
    try {
      const result = await props.onReadDirectory(active.signal)
      if (!guard.current.mounted || active.signal.aborted || generation !== guard.current.generation) return
      setDirectory(result)
      if (editing && editing !== 'new') setLatest(result.items.find((item) => item.id === editing.id) ?? null)
      if (deleting) { setDeleting(result.items.find((item) => item.id === deleting.id) ?? null); operation.clearError() }
    } catch (cause) { if (guard.current.mounted && !active.signal.aborted && generation === guard.current.generation) setReadError(cause instanceof Error ? cause.message : '分类目录读取未完成') }
    finally { if (guard.current.mounted && generation === guard.current.generation) setReading(false) }
  }
  function begin(category?: AssetCategorySummary) { if (operation.locked || reading) return; setEditing(category ?? 'new'); setName(category?.name ?? ''); setDeleting(null); setLatest(undefined); operation.clearError() }
  async function save(event: FormEvent) {
    event.preventDefault()
    if (!editing || operation.locked || reading || operation.rejected) return
    const trimmed = name.trim()
    if (!trimmed || trimmed.length > maximumAssetCategoryNameLength || /[\x00-\x1f\x7f]/.test(trimmed)) { setReadError('分类名称应为 1–80 个字符，不能包含换行或控制字符。'); return }
    setReadError('')
    await operation.submit(editing === 'new' ? { action: 'create-category', operationId: crypto.randomUUID(), name: trimmed } : { action: 'rename-category', operationId: crypto.randomUUID(), id: editing.id, expectedVersion: editing.version, name: trimmed })
  }
  const locked = operation.locked || reading
  const pending = operation.pending
  return <AssetCategoryDialogFrame title="管理素材分类" canClose={!reading && operation.canClose} onClose={props.onClose}>
    {props.recoveryNotice}
    <p>分类只整理你的素材库，不会改动画布内容或原文件。</p>
    {pending && <div className="asset-category-dialog-review" role="status"><strong>上次分类操作尚未确认</strong><p>{pending.action === 'create-category' ? `创建分类：${pending.name}` : pending.action === 'rename-category' ? `改名为：${pending.name}` : pending.action === 'delete-category' ? `删除分类：${directory?.items.find((item) => item.id === pending?.id)?.name || pending.id}` : '移动素材分类'}</p><p>保留原操作编号和内容。先核对结果，不会重新创建请求。</p><button type="button" disabled={operation.busy || props.disabled} onClick={() => void operation.inspect()}>核对原分类操作</button>{operation.missing && <button type="button" disabled={operation.busy || props.disabled} onClick={() => void operation.retry()}>沿用原操作重试</button>}</div>}
    {operation.error && <p role="alert">{operation.error}</p>}
    {readError && <p role="alert">{readError}</p>}
    <div className="asset-category-dialog-row"><span>{directory ? `${directory.items.length} / ${maximumAssetCategories} 个个人分类` : '分类目录尚未确认'}</span><button type="button" disabled={operation.busy || reading || props.disabled} onClick={() => void readDirectory()}>{reading ? '正在读取分类…' : '重新读取分类'}</button></div>
    {!editing && !deleting && <button type="button" disabled={locked || !directory || directory.items.length >= maximumAssetCategories} onClick={() => begin()}>新建素材分类</button>}
    {editing && <form onSubmit={(event) => void save(event)} aria-label={editing === 'new' ? '新建素材分类' : '重命名素材分类'}><label><span>{editing === 'new' ? '新分类名称' : '分类名称'}</span><input value={name} maxLength={maximumAssetCategoryNameLength} disabled={locked} onChange={(event) => { setName(event.target.value); if (editing === 'new') operation.clearError() }} /></label><div className="asset-category-dialog-row"><button type="button" disabled={locked} onClick={() => { setEditing(null); setLatest(undefined); operation.clearError() }}>取消编辑分类</button><button type="submit" className="is-primary" disabled={locked || !name.trim() || operation.rejected}>保存分类名称</button></div></form>}
    {operation.rejected && editing && editing !== 'new' && <div className="asset-category-dialog-review" role="status"><p>分类改名已被拒绝，名称草稿仍保留。重新读取最新分类后，再明确采用最新版本。</p>{latest === null && <p>原分类已删除，不能继续修改；可复制名称另建分类。</p>}{latest && <><p>最新分类：{latest.name} · 版本 {latest.version}</p><p>保留草稿：{name}</p><button type="button" disabled={locked} onClick={() => { setEditing(latest); setLatest(undefined); operation.clearError() }}>采用最新版本，保留名称草稿</button></>}</div>}
    {deleting && <div className="asset-category-dialog-review"><strong>删除分类“{deleting.name}”？</strong><p>其中 {deleting.counts.active + deleting.counts.trash} 份素材将回到“未分类”。素材文件、收藏、标签和回收状态都会保留。</p><div className="asset-category-dialog-row"><button type="button" disabled={locked} onClick={() => { setDeleting(null); operation.clearError() }}>取消删除分类</button><button type="button" className="is-danger" disabled={locked || operation.rejected} onClick={() => void operation.submit({ action: 'delete-category', operationId: crypto.randomUUID(), id: deleting.id, expectedVersion: deleting.version })}>删除分类并保留素材</button></div>{operation.rejected && <p>请重新读取分类后再次核对删除范围。</p>}</div>}
    {!editing && !deleting && <ul className="asset-category-dialog-list">{directory?.items.map((item) => <li key={item.id} className="asset-category-dialog-row"><strong>{item.name}</strong><small>{item.counts.active} 份 · 回收站 {item.counts.trash}</small><div><button type="button" aria-label={`重命名分类：${item.name}`} disabled={locked} onClick={() => begin(item)}>改名</button><button type="button" aria-label={`删除分类：${item.name}`} disabled={locked} onClick={() => { setDeleting(item); operation.clearError() }}>删除</button></div></li>)}</ul>}
    {operation.busy && <p role="status">正在核对分类操作…</p>}
    <footer><button type="button" disabled={!operation.canClose || reading} onClick={props.onClose}>{pending ? '关闭，保留待核对操作' : '完成分类管理'}</button></footer>
  </AssetCategoryDialogFrame>
}

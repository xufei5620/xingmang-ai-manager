import { useEffect, useRef, useState } from 'react'
import { Check, ChevronLeft, ChevronRight, ImageIcon, Info, LoaderCircle, Search, X } from 'lucide-react'
import type { CanvasImageAssetSummary, OfficialAssetItem, OfficialAssetPage, OfficialAssetQuery } from '../host'
import { acquireOfficialSelection, acquiredOfficialImage, officialAssetCategories, officialAssetKey, orderedOfficialSelection, type OfficialAssetAccess } from './official-asset-browser-model'
import './official-asset-browser.css'

interface OfficialAssetBrowserProps {
  access: OfficialAssetAccess
  scopeKey: string
  initialSearch?: string
  onUse?(assets: readonly CanvasImageAssetSummary[]): void | Promise<void>
  useLabel?: string
  single?: boolean
  readOnly?: boolean
  onAcquired?(): void
}
function OfficialCover({ item }: { item: OfficialAssetItem }) {
  const [failed, setFailed] = useState(false)
  return failed ? <span className="official-asset-unavailable"><ImageIcon size={24} />预览暂不可读取</span> : <img src={item.path} alt={item.title} loading="lazy" onError={() => setFailed(true)} />
}
export function OfficialAssetBrowser({ access, scopeKey, initialSearch = '', onUse, useLabel = '加入画布', single = false, readOnly = false, onAcquired }: OfficialAssetBrowserProps) {
  const [search, setSearch] = useState(initialSearch), [category, setCategory] = useState<NonNullable<OfficialAssetQuery['category']>>('all'), [offset, setOffset] = useState(0)
  const [page, setPage] = useState<OfficialAssetPage | null>(null), [loading, setLoading] = useState(true), [failure, setFailure] = useState(''), [revision, setRevision] = useState(0)
  const [selection, setSelection] = useState<string[]>([]), [detail, setDetail] = useState<OfficialAssetItem | null>(null)
  const [copies, setCopies] = useState<Record<string, CanvasImageAssetSummary>>({}), [uncertain, setUncertain] = useState<Record<string, OfficialAssetItem>>({})
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [actionError, setActionError] = useState(''), [completed, setCompleted] = useState(0)
  const detailPanel = useRef<HTMLElement>(null), detailTrigger = useRef<HTMLElement | null>(null), editable = useRef(!readOnly)
  editable.current = !readOnly
  const mounted = useRef(true), request = useRef(0), operation = useRef<AbortController | null>(null)
  const scope = JSON.stringify([scopeKey, category, search, offset]), currentScope = useRef(scope)
  currentScope.current = scope
  const accessRef = useRef(access); accessRef.current = access
  const previousSearch = useRef(initialSearch)
  useEffect(() => { if (previousSearch.current !== initialSearch) { previousSearch.current = initialSearch; setSearch(initialSearch); setOffset(0) } }, [initialSearch])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current++; operation.current?.abort() } }, [])
  useEffect(() => { setCopies({}); setUncertain({}); setDetail(null); setNotice(''); setActionError('') }, [scopeKey])
  useEffect(() => {
    const ticket = ++request.current, controller = new AbortController()
    operation.current?.abort(); operation.current = null; setBusy(false); setSelection([]); setDetail(null); setPage(null); setLoading(true); setFailure(''); setActionError(''); setNotice('')
    const timer = setTimeout(() => {
      void accessRef.current.list({ category, search: search.trim().slice(0, 160), offset, limit: 24 }, controller.signal).then((result) => {
        if (!mounted.current || controller.signal.aborted || request.current !== ticket || currentScope.current !== scope) return
        if (result.offset !== offset || result.limit !== 24) throw new Error('官方素材分页不一致，请重新读取。')
        setPage(result)
      }).catch((error) => { if (mounted.current && !controller.signal.aborted && request.current === ticket && currentScope.current === scope) setFailure(error instanceof Error ? error.message : '官方素材读取失败，请重试。') })
        .finally(() => { if (mounted.current && !controller.signal.aborted && request.current === ticket && currentScope.current === scope) setLoading(false) })
    }, search ? 250 : 0)
    return () => { clearTimeout(timer); controller.abort() }
  }, [scope, revision])
  useEffect(() => { if (detail) { detailPanel.current?.focus({ preventScroll: true }); detailPanel.current?.scrollIntoView({ block: 'nearest' }) } }, [detail])
  function closeDetail() { setDetail(null); detailTrigger.current?.focus({ preventScroll: true }); detailTrigger.current?.scrollIntoView({ block: 'nearest' }) }
  function openDetail(item: OfficialAssetItem, trigger: HTMLElement) { if (detail?.id === item.id) { closeDetail(); return } detailTrigger.current = trigger; setDetail(item) }
  function changeFilter(next: () => void) { operation.current?.abort(); operation.current = null; request.current++; setSelection([]); setDetail(null); setPage(null); setLoading(true); setRevision((value) => value + 1); next() }
  function remember(item: OfficialAssetItem, asset: CanvasImageAssetSummary) { const key = officialAssetKey(item); setCopies((previous) => ({ ...previous, [key]: asset })); setUncertain((previous) => { const next = { ...previous }; delete next[key]; return next }) }
  async function acquire(items: readonly OfficialAssetItem[], use: boolean, inspect = false) {
    if (operation.current || !editable.current || loading || !items.length) return
    const controller = new AbortController(), captured = scope
    operation.current = controller; setBusy(true); setCompleted(0); setActionError(''); setNotice('')
    const current = () => mounted.current && editable.current && !controller.signal.aborted && operation.current === controller && currentScope.current === captured
    let active: OfficialAssetItem | undefined
    let confirmed = false
    try {
      let assets: CanvasImageAssetSummary[]
      if (inspect) {
        active = items[0]
        const result = await accessRef.current.inspect({ id: active.id, version: active.version }, controller.signal)
        if (!current()) return
        const asset = acquiredOfficialImage(active, result); remember(active, asset); assets = [asset]
      } else assets = await acquireOfficialSelection({ items, access: { ...accessRef.current, acquire: (input, signal) => { active = items.find((item) => item.id === input.id && item.version === input.version); return accessRef.current.acquire(input, signal) } }, signal: controller.signal, current, remember, progress: setCompleted })
      if (!current()) return
      confirmed = true
      onAcquired?.()
      if (use && onUse) { await onUse(assets); if (!current()) return; setNotice(`已取得 ${assets.length} 份本人副本并${useLabel}。`); setSelection([]) }
      else setNotice(`已确认 ${assets.length} 份本人副本，可在我的素材中继续使用。重复取得会复用已有副本。`)
    } catch (error) {
      if (!current()) return
      if (active && !confirmed) setUncertain((previous) => ({ ...previous, [officialAssetKey(active!)]: active! }))
      setActionError(`${error instanceof Error ? error.message : '取得结果未确认。'}${use ? ' 本次未完成使用，请核对后再试。' : ''}`)
    } finally { if (operation.current === controller) { operation.current = null; if (mounted.current) setBusy(false) } }
  }
  const chosen = orderedOfficialSelection(page?.items ?? [], selection)
  const disabled = busy || readOnly || loading
  return <section className="official-asset-browser" aria-label="官方原创素材库">
    <p className="official-asset-intro">星芒原创图片素材 · 当前目录提供 PNG 图片。先取得到“我的素材”，再用于画布或参考图。取得不会运行模型；重复取得复用本人副本。</p>
    <label className="official-asset-search"><Search size={15} /><input aria-label="搜索官方素材" value={search} maxLength={160} placeholder="搜索角色、道具、服装…" onChange={(event) => changeFilter(() => { setSearch(event.target.value); setOffset(0) })} />{search && <button type="button" aria-label="清除官方素材搜索" onClick={() => changeFilter(() => { setSearch(''); setOffset(0) })}><X size={14} /></button>}</label>
    <nav className="official-asset-categories" aria-label="官方素材分类">{officialAssetCategories.map((item) => <button type="button" key={item.id} aria-pressed={category === item.id} onClick={() => changeFilter(() => { setCategory(item.id); setOffset(0) })}>{item.label}{page && <small>{page.counts[item.id]}</small>}</button>)}</nav>
    {!single && <div className="official-asset-batch"><span>已选 {chosen.length} 份</span><button type="button" disabled={disabled || !page?.items.length} onClick={() => setSelection(page!.items.map(officialAssetKey))}>全选本页</button><button type="button" disabled={busy || !selection.length} onClick={() => setSelection([])}>清空</button><button type="button" disabled={disabled || !chosen.length} onClick={() => void acquire(chosen, false)}>取得所选</button>{onUse && <button type="button" className="is-primary" disabled={disabled || !chosen.length} onClick={() => void acquire(chosen, true)}>取得并{useLabel}</button>}</div>}
    {busy && <p className="official-asset-feedback" role="status"><LoaderCircle size={15} />正在取得并核对副本（已确认 {completed} 份）…</p>}
    {notice && <p className="official-asset-feedback" role="status"><Check size={15} />{notice}</p>}{actionError && <p className="official-asset-feedback is-error" role="alert">{actionError}</p>}
    {loading ? <div className="official-asset-empty" role="status"><LoaderCircle size={23} />正在读取官方素材…</div> : failure ? <div className="official-asset-empty" role="alert"><p>{failure}</p><button type="button" onClick={() => setRevision((value) => value + 1)}>重新读取</button></div> : !page?.items.length ? <div className="official-asset-empty"><ImageIcon size={27} /><strong>没有匹配的官方素材</strong><p>换个关键词或分类，再找找创作灵感。</p></div> : <div className="official-asset-grid">{page.items.map((item) => {
      const key = officialAssetKey(item), selected = selection.includes(key)
      return <article className={selected ? 'is-selected' : ''} key={key}>
        <button type="button" className="official-asset-cover" aria-label={`查看官方素材：${item.title}`} onClick={(event) => openDetail(item, event.currentTarget)}><OfficialCover item={item} /></button>
        {!single && <button type="button" className="official-asset-select" role="checkbox" aria-checked={selected} aria-label={`选择官方素材：${item.title}`} disabled={disabled} onClick={() => setSelection((previous) => selected ? previous.filter((value) => value !== key) : [...previous, key])}>{selected ? <Check size={13} /> : <span />}</button>}
        <div className="official-asset-card-info"><strong>{item.title}</strong><small>{officialAssetCategories.find((entry) => entry.id === item.category)?.label} · {item.width} × {item.height}</small><div className="official-asset-card-actions"><button type="button" aria-label={`出处与详情：${item.title}`} onClick={(event) => openDetail(item, event.currentTarget)}><Info size={13} />详情</button><button type="button" disabled={disabled} onClick={() => void acquire([item], single && !!onUse)}>{copies[key] ? single ? '使用本人副本' : '再次取得' : single ? '取得并选用' : '取得副本'}</button></div>{uncertain[key] && <button type="button" className="official-asset-inspect" disabled={disabled} onClick={() => void acquire([item], false, true)}>核对取得结果</button>}</div>
      </article>
    })}</div>}
    {detail && <section ref={detailPanel} tabIndex={-1} className="official-asset-detail" aria-label={`官方素材详情：${detail.title}`}><header><strong>{detail.title}</strong><button type="button" aria-label="关闭官方素材详情" onClick={closeDetail}><X size={16} /></button></header><OfficialCover item={detail} /><p>{detail.description}</p><dl><div><dt>出处</dt><dd>{detail.attribution}</dd></div><div><dt>使用说明</dt><dd>{detail.licenseLabel}</dd></div><div><dt>文件</dt><dd>PNG · {detail.width} × {detail.height} · {Math.ceil(detail.bytes / 1024)} KB</dd></div><div><dt>版本</dt><dd>{detail.version}</dd></div></dl><p className="official-asset-tags">{detail.tags.map((tag) => <span key={tag}>{tag}</span>)}</p><button type="button" disabled={disabled} onClick={() => void acquire([detail], single && !!onUse)}>{single ? '取得并选用' : '取得到我的素材'}</button></section>}
    <footer className="official-asset-pagination"><span>{loading ? '读取中' : page ? `${page.total} 份匹配素材` : '数量待核对'}</span><button type="button" disabled={disabled || !page || offset === 0} aria-label="上一页官方素材" onClick={() => changeFilter(() => setOffset(Math.max(0, offset - 24)))}><ChevronLeft size={15} /></button><button type="button" disabled={disabled || !page?.hasMore} aria-label="下一页官方素材" onClick={() => changeFilter(() => setOffset(offset + 24))}><ChevronRight size={15} /></button></footer>
  </section>
}

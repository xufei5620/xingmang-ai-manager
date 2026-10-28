import { useEffect, useRef, useState } from 'react'
import { BookmarkPlus, ChevronDown, Search } from 'lucide-react'
import { hostBridge, type CanvasWorkshopCreateInput, type CanvasWorkshopItem, type CanvasWorkshopItemSummary } from '../host'
import type { ImageCropRecipe } from './recipe'
import type { ImageCropEditorPreferences } from './crop-editor-preferences'
import { assertCropPresetReceipt, buildCropPresetWorkflow, isCropPresetSummary, readCropPreset, type CropPresetConfiguration } from './crop-presets'
import './crop-presets.css'

export function CropPresetPanel({ recipe, preferences, sourceReady, onApply, onBusyChange }: { recipe: ImageCropRecipe; preferences: ImageCropEditorPreferences; sourceReady: boolean; onApply(value: CropPresetConfiguration): void; onBusyChange?(busy: boolean): void }) {
  const [expanded, setExpanded] = useState(false)
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [revision, setRevision] = useState(0)
  const [items, setItems] = useState<CanvasWorkshopItemSummary[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [reading, setReading] = useState(false)
  const [selected, setSelected] = useState<CanvasWorkshopItem | null>(null)
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const request = useRef<CanvasWorkshopCreateInput | null>(null)
  const busy = useRef(false)
  const scope = useRef(0), listSequence = useRef(0), readSequence = useRef(0)
  useEffect(() => () => { scope.current++; listSequence.current++; readSequence.current++ }, [])
  useEffect(() => {
    if (!expanded) return
    const sequence = ++listSequence.current, epoch = scope.current
    const bridge = hostBridge()
    setLoading(true)
    const timer = setTimeout(() => {
      if (!bridge.listWorkshopItems) { setError('当前环境暂不支持个人裁剪预设'); setLoading(false); return }
      const filter = { kind: 'node' as const, nodeKind: 'image-crop' as const, view: 'active' as const, q: query, offset, limit: 6 }
      void bridge.listWorkshopItems(filter).then((page) => {
        if (sequence !== listSequence.current || epoch !== scope.current) return
        if (page.items.some((item) => !isCropPresetSummary(item))) throw new Error('裁剪预设列表类型无法核对，请刷新后重试')
        setItems(page.items); setTotal(page.total)
      }).catch((cause) => { if (sequence === listSequence.current && epoch === scope.current) setError(cause instanceof Error ? cause.message : '裁剪预设读取失败') })
        .finally(() => { if (sequence === listSequence.current && epoch === scope.current) setLoading(false) })
    }, query ? 180 : 0)
    return () => { clearTimeout(timer); listSequence.current++ }
  }, [expanded, query, offset, revision])

  function changePage(search: string, nextOffset: number) {
    listSequence.current++; readSequence.current++
    setQuery(search); setOffset(nextOffset); setItems([]); setSelected(null); setReading(false); setError(''); setNotice('')
  }
  async function read(id: string) {
    if (busy.current) return
    const bridge = hostBridge(), sequence = ++readSequence.current, epoch = scope.current
    if (!bridge.readWorkshopItem) { setError('当前环境暂不支持读取裁剪预设'); return }
    setReading(true); setSelected(null); setError(''); setNotice('')
    try {
      const item = await bridge.readWorkshopItem(id)
      if (epoch !== scope.current || sequence !== readSequence.current) return
      if (item.id !== id) throw new Error('裁剪预设编号不一致，请重新读取')
      readCropPreset(item)
      setSelected(item)
    } catch (cause) { if (epoch === scope.current && sequence === readSequence.current) setError(cause instanceof Error ? cause.message : '裁剪预设无法读取') }
    finally { if (epoch === scope.current && sequence === readSequence.current) setReading(false) }
  }
  async function save() {
    if (busy.current || !name.trim()) return
    const bridge = hostBridge(), epoch = scope.current
    if (!bridge.createWorkshopItem) { setError('当前环境暂不支持保存裁剪预设'); return }
    try {
      if (!request.current) request.current = { operationId: crypto.randomUUID(), kind: 'node', name: name.trim(), description: '裁剪参数与编辑偏好', category: 'general', tags: ['裁剪预设'], workflow: buildCropPresetWorkflow(name, recipe, preferences) }
    } catch (cause) { setError(cause instanceof Error ? cause.message : '当前裁剪参数无法保存'); return }
    busy.current = true; setSaving(true); setSubmitted(true); setError(''); setNotice(''); onBusyChange?.(true)
    try {
      const item = await bridge.createWorkshopItem(request.current)
      if (epoch !== scope.current) return
      assertCropPresetReceipt(item, request.current)
      request.current = null; setSubmitted(false); setName(''); setNotice(`已保存「${item.name}」，当前画布参数尚未提交。`)
      setOffset(0); setRevision((value) => value + 1)
    } catch (cause) { if (epoch === scope.current) setError(`${cause instanceof Error ? cause.message : '保存结果暂未确认'}。重试会核对同一份配置，请勿重复新建。`) }
    finally { if (epoch === scope.current) { busy.current = false; setSaving(false); onBusyChange?.(false) } }
  }
  return <section className="crop-preset-panel" aria-label="个人裁剪预设">
    <button type="button" className="crop-preset-toggle" aria-expanded={expanded} disabled={saving} onClick={() => setExpanded(!expanded)}><BookmarkPlus size={14} /><span>个人裁剪预设</span><ChevronDown size={14} /></button>
    {expanded && <div className="crop-preset-content">
      <p>保存到我的工坊。选择预设后先载入草稿，再点击下方「应用参数」。</p>
      {!sourceReady && <p role="status">请先连接图片并等待原图尺寸读取完成，再载入预设。</p>}
      <div className="crop-preset-save"><label>预设名称<input aria-label="裁剪预设名称" value={name} maxLength={160} placeholder="例如：电商竖版 4:5" disabled={saving || submitted} onChange={(event) => setName(event.target.value)} /></label><button type="button" disabled={saving || !name.trim()} onClick={() => void save()}>{saving ? '保存中…' : submitted ? '核对原保存' : '保存当前配置'}</button></div>
      <label className="crop-preset-search"><Search size={14} /><input aria-label="搜索裁剪预设" value={query} maxLength={160} placeholder="搜索名称、说明或标签" disabled={saving} onChange={(event) => changePage(event.target.value, 0)} /></label>
      {error && <p className="image-tool-error" role="alert">{error}<button type="button" disabled={saving} onClick={() => { setError(''); setRevision((value) => value + 1) }}>刷新列表</button></p>}
      {notice && <p role="status" className="crop-preset-notice">{notice}</p>}
      <div className="crop-preset-list" aria-busy={loading || reading}>
        {loading ? <p role="status">正在读取裁剪预设…</p> : items.length ? items.map((item) => <button type="button" key={item.id} aria-pressed={selected?.id === item.id} disabled={saving} onClick={() => void read(item.id)}><strong>{item.name}</strong><small>{item.description || '裁剪配置'}</small></button>) : <p>没有匹配的裁剪预设。</p>}
        {reading && <p role="status">正在核对预设参数…</p>}
      </div>
      {selected && <div className="crop-preset-selected"><span>已选择：{selected.name}</span><button type="button" disabled={saving || reading || !sourceReady} onClick={() => { try { onApply(readCropPreset(selected)); setNotice(`已将「${selected.name}」载入编辑草稿，请预览后应用参数。`); setError('') } catch (cause) { setError(cause instanceof Error ? cause.message : '预设无法应用') } }}>载入编辑草稿</button></div>}
      <div className="crop-preset-pagination"><button type="button" disabled={saving || loading || offset === 0} onClick={() => changePage(query, Math.max(0, offset - 6))}>上一页</button><span>{total} 项裁剪预设</span><button type="button" disabled={saving || loading || offset + 6 >= total} onClick={() => changePage(query, offset + 6)}>下一页</button></div>
    </div>}
  </section>
}

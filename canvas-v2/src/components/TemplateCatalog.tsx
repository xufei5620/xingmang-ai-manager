import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Search, Sparkles, X } from 'lucide-react'
import type { CanvasAssetPage, CanvasAssetSummary } from '../host'
import { canvasTemplateIndustries, canvasTemplateCompatibility, estimateCanvasTemplate, searchCanvasTemplates } from '../templates/template-catalog'
import type { CanvasTemplate } from '../templates/template-types'
import { createTemplateConfiguratorState, validateTemplateConfiguratorState } from './template-configurator-model'

interface TemplateCatalogProps {
  open: boolean
  templates: readonly CanvasTemplate[]
  assets: CanvasAssetPage
  imageModels: readonly string[]
  videoModels: readonly string[]
  initialTemplateId?: string | null
  onClose(): void
  onPickAsset(): Promise<CanvasAssetSummary | null>
  onInsert(templateId: string, values: Readonly<Record<string, unknown>> | undefined, draft: boolean): void
}

export function TemplateCatalog({ open, templates, assets, imageModels, videoModels, initialTemplateId, onClose, onPickAsset, onInsert }: TemplateCatalogProps) {
  const [query, setQuery] = useState('')
  const [industry, setIndustry] = useState<'all' | CanvasTemplate['industry']>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [fields, setFields] = useState<Record<string, string>>({})
  const [submitted, setSubmitted] = useState(false)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose }, [onClose])

  useEffect(() => {
    if (!open) return
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setSelectedId(initialTemplateId ?? null)
    setSubmitted(false)
    const initial = templates.find((template) => template.id === initialTemplateId)
    setFields(initial ? { ...createTemplateConfiguratorState(initial) } : {})
    const frame = requestAnimationFrame(() => closeButtonRef.current?.focus())
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])') ?? [])]
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', keydown)
    return () => { cancelAnimationFrame(frame); document.removeEventListener('keydown', keydown); previousFocusRef.current?.focus() }
  }, [initialTemplateId, open, templates])

  const filtered = useMemo(() => searchCanvasTemplates(templates, query).filter((template) => industry === 'all' || template.industry === industry), [industry, query, templates])
  const selected = templates.find((template) => template.id === selectedId) ?? null
  const assetIds = useMemo(() => new Set(assets.items.map((asset) => asset.assetId)), [assets.items])
  const validation = selected ? validateTemplateConfiguratorState(selected, fields, assetIds) : null

  if (!open) return null
  return (
    <div className="template-catalog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section ref={dialogRef} className="template-catalog-dialog" role="dialog" aria-modal="true" aria-label={selected ? `配置模板：${selected.name}` : '行业模板库'}>
        <header className="template-catalog-header">
          <div>
            {selected && <button type="button" className="template-back" aria-label="返回行业模板库" onClick={() => { setSelectedId(null); setSubmitted(false) }}><ArrowLeft size={16} /></button>}
            <span><Sparkles size={18} /><strong>{selected ? selected.name : '行业模板库'}</strong></span>
          </div>
          <button ref={closeButtonRef} type="button" className="template-close" aria-label="关闭模板库" onClick={onClose}><X size={17} /></button>
        </header>

        {selected ? (
          <div className="template-configurator">
            <aside>
              <span className="template-swatch-large" style={{ background: selected.thumbnail.value }} />
              <h2>{selected.deliverable}</h2>
              <p>{selected.description}</p>
              {selected.disclaimer && <div className="template-disclaimer" role="note"><strong>交付边界</strong>{selected.disclaimer}</div>}
              {(() => { const estimate = estimateCanvasTemplate(selected); return <div className="template-request-estimate" aria-label="最大请求估算"><span>图片请求 {estimate.imageRequests}</span><span>视频请求 {estimate.videoRequests}</span><strong>最多 {estimate.paidRequests} 次付费请求</strong></div> })()}
            </aside>
            <form onSubmit={(event) => {
              event.preventDefault()
              setSubmitted(true)
              if (validation?.valid) onInsert(selected.id, validation.values, false)
            }}>
              <h3>填写模板内容</h3>
              {selected.variables.map((variable) => (
                <label key={variable.id}>
                  <span>{variable.label}{variable.required && <b aria-label="必填"> *</b>}</span>
                  {variable.type === 'asset' ? (
                    <>
                      <select aria-label={variable.label} value={fields[variable.id] ?? ''} onChange={(event) => setFields((current) => ({ ...current, [variable.id]: event.target.value }))}>
                        <option value="">选择本地图片素材</option>
                        {assets.items.filter((asset) => asset.mediaType === 'image').map((asset) => <option key={asset.assetId} value={asset.assetId}>{asset.displayName || asset.fileName}</option>)}
                      </select>
                      <button type="button" className="template-import-asset" onClick={async () => {
                        const asset = await onPickAsset()
                        if (asset?.mediaType === 'image') setFields((current) => ({ ...current, [variable.id]: asset.assetId }))
                      }}>导入本地素材</button>
                    </>
                  ) : variable.type === 'select' ? (
                    <select aria-label={variable.label} value={fields[variable.id] ?? ''} onChange={(event) => setFields((current) => ({ ...current, [variable.id]: event.target.value }))}>
                      <option value="">请选择</option>{variable.options?.map((option) => <option key={option} value={option}>{option}</option>)}
                    </select>
                  ) : (
                    <textarea aria-label={variable.label} rows={3} value={fields[variable.id] ?? ''} onChange={(event) => setFields((current) => ({ ...current, [variable.id]: event.target.value }))} />
                  )}
                  {submitted && validation?.errors[variable.id] && <small className="template-field-error">{validation.errors[variable.id]}</small>}
                </label>
              ))}
              {selected.variables.some((variable) => variable.type === 'asset') && assets.items.every((asset) => asset.mediaType !== 'image') && <p className="template-empty-assets">素材库里还没有图片。可以先插入空白骨架，再把图片拖到对应节点。</p>}
              <footer>
                <button type="button" onClick={() => onInsert(selected.id, undefined, true)}>先插入空白骨架</button>
                <button type="submit" className="is-primary" disabled={!canvasTemplateCompatibility(selected, imageModels, videoModels).available}>填写并插入</button>
              </footer>
              {!canvasTemplateCompatibility(selected, imageModels, videoModels).available && <p className="template-unavailable">{canvasTemplateCompatibility(selected, imageModels, videoModels).reasons.join('；')}</p>}
            </form>
          </div>
        ) : (
          <div className="template-catalog-body">
            <div className="template-catalog-tools">
              <label><Search size={15} /><input aria-label="搜索行业模板" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务、交付物或行业" /></label>
              <select aria-label="行业筛选" value={industry} onChange={(event) => setIndustry(event.target.value as typeof industry)}>
                <option value="all">全部行业</option>{canvasTemplateIndustries.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
              </select>
            </div>
            <div className="template-featured-title"><strong>可执行行业任务</strong><span>{filtered.length} 套</span></div>
            <div className="template-card-grid">
              {filtered.map((template) => {
                const estimate = estimateCanvasTemplate(template)
                const compatibility = canvasTemplateCompatibility(template, imageModels, videoModels)
                return <article key={template.id} className="template-card">
                  <span className="template-card-swatch" style={{ background: template.thumbnail.value }} />
                  <div><small>{canvasTemplateIndustries.find((entry) => entry.id === template.industry)?.label}</small><h3>{template.name}</h3><p>{template.deliverable}</p></div>
                  <div className="template-card-meta" aria-label="请求估算"><span>{estimate.imageRequests} 图</span><span>{estimate.videoRequests} 视频</span></div>
                  <button type="button" onClick={() => { setSelectedId(template.id); setFields({ ...createTemplateConfiguratorState(template) }); setSubmitted(false) }}>查看并配置</button>
                  {!compatibility.available && <small className="template-card-warning">可先插入骨架 · 当前模型未就绪</small>}
                </article>
              })}
            </div>
          </div>
        )}
      </section>
    </div>
  )
}

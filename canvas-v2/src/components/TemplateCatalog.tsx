import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Images, LoaderCircle, Search, Sparkles, X } from 'lucide-react'
import type { CanvasAssetPage, CanvasAssetSummary } from '../host'
import { canvasTemplateIndustries, canvasTemplateCompatibility, estimateCanvasTemplate, searchCanvasTemplates } from '../templates/template-catalog'
import type { CanvasTemplate } from '../templates/template-types'
import { createTemplateConfiguratorState, validateTemplateConfiguratorState } from './template-configurator-model'
import { SafeImage } from './MediaPreview'
import type { OfficialAssetAccess } from './official-asset-browser-model'
import { TemplateAssetPicker } from './TemplateAssetPicker'
import { createTemplateReferenceGuard, isTemplateImageAsset, retainTemplateReference, templateReferenceIds, type TemplateAssetLoader, type TemplateReferenceAssets } from './template-asset-picker-model'
import { createTemplateSubmissionController } from './template-submission-model'

interface TemplateCatalogProps {
  open: boolean
  templates: readonly CanvasTemplate[]
  assets: CanvasAssetPage
  imageModels: readonly string[]
  videoModels: readonly string[]
  textModels?: readonly string[]
  initialTemplateId?: string | null
  onClose(): void
  onPickAsset(): Promise<CanvasAssetSummary | null>
  onListAssets?: TemplateAssetLoader
  officialAccess?: OfficialAssetAccess
  assetScopeKey?: string
  onAssetAcquired?(): void
  onInsert(templateId: string, values: Readonly<Record<string, unknown>> | undefined, draft: boolean): void | Promise<void>
}

export function TemplateCatalog({ open, templates, assets, imageModels, videoModels, textModels = [], initialTemplateId, onClose, onPickAsset, onListAssets, onInsert, officialAccess, assetScopeKey, onAssetAcquired }: TemplateCatalogProps) {
  const [query, setQuery] = useState('')
  const [industry, setIndustry] = useState<'all' | CanvasTemplate['industry']>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [fields, setFields] = useState<Record<string, string>>({})
  const [submitted, setSubmitted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submissionError, setSubmissionError] = useState<string | null>(null)
  const submission = useRef(createTemplateSubmissionController())
  const [references, setReferences] = useState<TemplateReferenceAssets>({})
  const [pickerVariable, setPickerVariable] = useState<string | null>(null)
  const [importingVariable, setImportingVariable] = useState<string | null>(null)
  const [referenceMessage, setReferenceMessage] = useState<{ text: string; error: boolean } | null>(null)
  const referenceGuard = useRef(createTemplateReferenceGuard())
  const importInFlight = useRef(false)
  const currentSelection = useRef({ open, templateId: selectedId })
  currentSelection.current = { open, templateId: selectedId }
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = () => pickerVariable ? cancelPicker() : closeCatalog()

  function closeCatalog() {
    if (submission.current.active()) return
    referenceGuard.current.invalidate()
    submission.current.invalidate()
    onClose()
  }
  function cancelPicker() {
    const variableId = pickerVariable
    referenceGuard.current.invalidate()
    setPickerVariable(null)
    requestAnimationFrame(() => { if (variableId) document.getElementById(`template-reference-${variableId}`)?.focus() })
  }
  function chooseTemplate(templateId: string | null) {
    if (submission.current.active()) return
    referenceGuard.current.invalidate()
    const template = templates.find((entry) => entry.id === templateId)
    setSelectedId(templateId)
    setFields(template ? { ...createTemplateConfiguratorState(template) } : {})
    setReferences({})
    setPickerVariable(null)
    setReferenceMessage(null)
    setImportingVariable(null)
    setSubmitted(false)
    setSubmissionError(null)
  }
  function selectReference(variableId: string, asset: CanvasAssetSummary) {
    if (!isTemplateImageAsset(asset)) throw new Error('请选择已保存且可读取的图片素材。')
    setReferences((current) => retainTemplateReference(current, variableId, asset))
    setFields((current) => ({ ...current, [variableId]: asset.assetId }))
    setReferenceMessage(null)
  }
  async function importReference(variableId: string) {
    if (!selectedId || submission.current.active()) return
    if (importInFlight.current) { setReferenceMessage({ text: '仍有一次图片导入等待结果，请先在素材库核对。关闭模板不会撤销已提交的上传。', error: false }); return }
    importInFlight.current = true
    const ticket = referenceGuard.current.begin(selectedId, variableId)
    setImportingVariable(variableId)
    setReferenceMessage(null)
    try {
      const asset = await onPickAsset()
      if (!currentSelection.current.open || currentSelection.current.templateId !== ticket.templateId || !referenceGuard.current.current(ticket)) return
      if (asset) selectReference(variableId, asset)
    } catch (reason) {
      if (currentSelection.current.open && currentSelection.current.templateId === ticket.templateId && referenceGuard.current.current(ticket)) setReferenceMessage({ text: reason instanceof Error ? reason.message : '参考图导入未确认，请在素材库核对后再试。', error: true })
    } finally {
      importInFlight.current = false
      if (referenceGuard.current.current(ticket)) setImportingVariable(null)
    }
  }

  async function insertTemplate(draft: boolean) {
    if (!selected || importingVariable || submission.current.active()) return
    if (!draft) {
      setSubmitted(true)
      if (!validation?.valid) return
    }
    const templateId = selected.id
    const values = draft ? undefined : validation?.values
    referenceGuard.current.invalidate()
    await submission.current.submit(() => onInsert(templateId, values, draft), {
      onStart() { setSubmitting(true); setSubmissionError(null) },
      onFinish() { setSubmitting(false) },
      onSuccess() { closeCatalog() },
      onError(reason) { setSubmissionError(reason instanceof Error ? reason.message : '模板插入未确认，请保留当前配置并重试。') },
    })
  }

  useEffect(() => {
    submission.current.invalidate()
    if (!open) return
    referenceGuard.current.invalidate()
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setSelectedId(initialTemplateId ?? null)
    setSubmitted(false)
    setSubmitting(false)
    setSubmissionError(null)
    setReferences({})
    setPickerVariable(null)
    setImportingVariable(null)
    setReferenceMessage(null)
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
    return () => { referenceGuard.current.invalidate(); submission.current.invalidate(); cancelAnimationFrame(frame); document.removeEventListener('keydown', keydown); previousFocusRef.current?.focus() }
  }, [initialTemplateId, open, templates])

  const filtered = useMemo(() => searchCanvasTemplates(templates, query).filter((template) => industry === 'all' || template.industry === industry), [industry, query, templates])
  const selected = templates.find((template) => template.id === selectedId) ?? null
  const assetIds = useMemo(() => templateReferenceIds(references), [references])
  const validation = selected ? validateTemplateConfiguratorState(selected, fields, assetIds) : null

  if (!open) return null
  return (
    <div className="template-catalog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeCatalog() }}>
      <section ref={dialogRef} className="template-catalog-dialog" role="dialog" aria-modal="true" aria-label={pickerVariable ? '为模板选择参考图片' : selected ? `配置模板：${selected.name}` : '行业模板库'}>
        <header className="template-catalog-header">
          <div>
            {selected && !pickerVariable && <button type="button" className="template-back" aria-label="返回行业模板库" disabled={submitting} onClick={() => chooseTemplate(null)}><ArrowLeft size={16} /></button>}
            <span><Sparkles size={18} /><strong>{selected ? selected.name : '行业模板库'}</strong></span>
          </div>
          <button ref={closeButtonRef} type="button" className="template-close" aria-label="关闭模板库" disabled={submitting} onClick={closeCatalog}><X size={17} /></button>
        </header>

        {selected && pickerVariable ? <TemplateAssetPicker label={selected.variables.find((entry) => entry.id === pickerVariable)?.label ?? '参考图'} selected={references[pickerVariable]} fallbackPage={assets} onListAssets={onListAssets} officialAccess={officialAccess} scopeKey={assetScopeKey} onAcquired={onAssetAcquired} onCancel={cancelPicker} onChoose={(asset) => {
          if (!currentSelection.current.open || currentSelection.current.templateId !== selected.id) return
          selectReference(pickerVariable, asset)
          cancelPicker()
        }} /> : selected ? (
          <div className="template-configurator">
            <aside>
              <span className="template-swatch-large" style={{ background: selected.thumbnail.value }} />
              <h2>{selected.deliverable}</h2>
              <p>{selected.description}</p>
              {selected.disclaimer && <div className="template-disclaimer" role="note"><strong>交付边界</strong>{selected.disclaimer}</div>}
              {(() => { const estimate = estimateCanvasTemplate(selected); return <div className="template-request-estimate" aria-label="最大请求估算"><span>图片请求 {estimate.imageRequests}</span><span>视频请求 {estimate.videoRequests}</span><span>文字请求 {estimate.textRequests}</span><strong>最多 {estimate.paidRequests} 次付费请求</strong></div> })()}
            </aside>
            <form onSubmit={(event) => {
              event.preventDefault()
              void insertTemplate(false)
            }}>
              <h3>填写模板内容</h3>
              {selected.variables.map((variable) => (
                variable.type === 'asset' ? <div className="template-reference-field" key={variable.id} role="group" aria-labelledby={`template-reference-label-${variable.id}`}>
                  <span id={`template-reference-label-${variable.id}`}>{variable.label}{variable.required && <b aria-label="必填"> *</b>}</span>
                  {references[variable.id] && <div className="template-reference-preview"><SafeImage src={references[variable.id].thumbnailUrl} fallbackSrc={references[variable.id].localUrl} alt={references[variable.id].displayName || references[variable.id].fileName} /><span>{references[variable.id].displayName || references[variable.id].fileName}</span><button type="button" className="template-close" aria-label={`移除${variable.label}`} disabled={Boolean(importingVariable) || submitting} onClick={() => { referenceGuard.current.invalidate(); setReferences((current) => { const next = { ...current }; delete next[variable.id]; return next }); setFields((current) => ({ ...current, [variable.id]: '' })) }}><X size={15} /></button></div>}
                  <div className="template-reference-actions"><button id={`template-reference-${variable.id}`} type="button" className="template-import-asset" disabled={Boolean(importingVariable) || submitting} onClick={() => { referenceGuard.current.invalidate(); setPickerVariable(variable.id); setReferenceMessage(null) }}><Images size={15} />{references[variable.id] ? '更换素材库图片' : '从素材库选择图片'}</button><button type="button" className="template-import-asset" disabled={Boolean(importingVariable) || submitting} onClick={() => void importReference(variable.id)}>{importingVariable === variable.id && <LoaderCircle size={14} className="template-asset-spin" />}{importingVariable === variable.id ? '正在导入…' : '导入本地图片'}</button></div>
                  {!references[variable.id] && <small>从完整图片素材库选择，或上传自己的参考图。</small>}
                  {submitted && validation?.errors[variable.id] && <small className="template-field-error">{validation.errors[variable.id]}</small>}
                </div> : <label key={variable.id}>
                  <span>{variable.label}{variable.required && <b aria-label="必填"> *</b>}</span>
                  {variable.type === 'select' ? (
                    <select aria-label={variable.label} disabled={submitting} value={fields[variable.id] ?? ''} onChange={(event) => setFields((current) => ({ ...current, [variable.id]: event.target.value }))}>
                      <option value="">请选择</option>{variable.options?.map((option) => <option key={option} value={option}>{option}</option>)}
                    </select>
                  ) : (
                    <textarea aria-label={variable.label} disabled={submitting} rows={3} value={fields[variable.id] ?? ''} onChange={(event) => setFields((current) => ({ ...current, [variable.id]: event.target.value }))} />
                  )}
                  {submitted && validation?.errors[variable.id] && <small className="template-field-error">{validation.errors[variable.id]}</small>}
                </label>
              ))}
              {referenceMessage && <p className={`template-reference-message${referenceMessage.error ? ' is-error' : ''}`} role={referenceMessage.error ? 'alert' : 'status'}>{referenceMessage.text}</p>}
              {importingVariable && <p className="template-reference-message" role="status">关闭模板会停止等待，已提交的素材上传仍可能完成，可在素材库核对。</p>}
              {submitting && <p className="template-reference-message" role="status">正在保存模板工程，请等待结果确认。</p>}
              {submissionError && <p className="template-reference-message is-error" role="alert">{submissionError}</p>}
              <footer>
                <button type="button" disabled={Boolean(importingVariable) || submitting} onClick={() => void insertTemplate(true)}>先插入空白骨架</button>
                <button type="submit" className="is-primary" disabled={Boolean(importingVariable) || submitting}>填写并插入</button>
              </footer>
              {!canvasTemplateCompatibility(selected, imageModels, videoModels, textModels).available && <p className="template-unavailable">可以先填写并保存工作流。实际生成前需要接入兼容模型：{canvasTemplateCompatibility(selected, imageModels, videoModels, textModels).reasons.join('；')}</p>}
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
                const compatibility = canvasTemplateCompatibility(template, imageModels, videoModels, textModels)
                return <article key={template.id} className="template-card">
                  <span className="template-card-swatch" style={{ background: template.thumbnail.value }} />
                  <div><small>{canvasTemplateIndustries.find((entry) => entry.id === template.industry)?.label}</small><h3>{template.name}</h3><p>{template.deliverable}</p></div>
                  <div className="template-card-meta" aria-label="请求估算"><span>{estimate.imageRequests} 图</span><span>{estimate.videoRequests} 视频</span>{estimate.textRequests > 0 && <span>{estimate.textRequests} 文字</span>}</div>
                  <button type="button" onClick={() => chooseTemplate(template.id)}>查看并配置</button>
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

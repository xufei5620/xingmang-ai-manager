import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { ArrowDown, ArrowUp, Check, Images, LoaderCircle, Package, Upload, X } from 'lucide-react'
import type { CanvasAssetPage, CanvasAssetSummary, CanvasImageAssetSummary } from '../host'
import { buildCommerceTaskPrompt, commercePreserveOptions, commerceStylePresets, commerceTaskLabels, commerceViews, defaultCommerceTask, type CommercePreserve, type CommerceTask, type CommerceTaskKind, type CommerceView } from '../commerce/commerce-task'
import type { ImageReferenceRole } from '../commerce/image-reference-order'
import { defaultImageQuality, defaultImageSize, imageModelPreset, imageQualityOptions, imageSizeLabel } from '../models'
import { inspectImageResolutionSelection } from '../runtime/image-resolution-selection'
import { imageCandidateCounts, type ImageCandidateCount } from '../runtime/image-candidate-count'
import { SafeImage } from './MediaPreview'
import { TemplateAssetPicker } from './TemplateAssetPicker'
import { isTemplateImageAsset, type TemplateAssetLoader } from './template-asset-picker-model'
import type { OfficialAssetAccess } from './official-asset-browser-model'
import { buildCommerceTaskBranches, buildCommerceTaskSubmission, chooseCommerceTaskAsset, commerceTaskReferences, inspectCommerceTaskSize, type CommerceTaskDialogDraft, type CommerceTaskGenerationDraft, type CommerceTaskReferenceDraft } from './commerce-task-ui'
import './commerce-task.css'

export type { CommerceTaskDialogDraft, CommerceTaskReferenceDraft } from './commerce-task-ui'
export interface CommerceTaskDialogProps {
  mode: 'create' | 'edit'
  scopeKey: string
  isCurrent(): boolean
  initialTask: CommerceTask
  initialReferences?: readonly CommerceTaskReferenceDraft[]
  assets: CanvasAssetPage
  onListAssets?: TemplateAssetLoader
  onPickAsset(): Promise<CanvasAssetSummary | null>
  onReadAsset?(assetId: string, signal?: AbortSignal): Promise<CanvasImageAssetSummary>
  officialAccess?: OfficialAssetAccess
  onAssetAcquired?(): void
  imageModels: readonly { id: string; label: string }[]
  initialModel?: string
  initialSize?: string
  initialImageResolution?: '1K' | '2K' | '4K'
  initialQuality?: string
  initialCandidateCount?: ImageCandidateCount
  analysisUnavailableReason?: string
  onApply(draft: CommerceTaskDialogDraft): Promise<void>
  onClose(): void
}

export function CommerceTaskDialog(props: CommerceTaskDialogProps) {
  const [task, setTask] = useState(props.initialTask), [references, setReferences] = useState(() => commerceTaskReferences(props.initialTask, props.initialReferences ?? []))
  const [views, setViews] = useState<CommerceView[]>(() => { const initial = props.initialTask; return initial.kind === 'product-view' ? [initial.view, ...(['left', 'three-quarter'] as const).filter((view) => view !== initial.view)] : ['front', 'left', 'three-quarter'] })
  const [prompt, setPrompt] = useState(''), [autoAnalyze, setAutoAnalyze] = useState(false)
  const [generation, setGeneration] = useState<CommerceTaskGenerationDraft>({ model: props.initialModel ?? props.imageModels.find((entry) => imageModelPreset(entry.id).supportsEdits)?.id ?? '', size: props.initialSize ?? defaultImageSize, imageResolution: props.initialImageResolution ?? '1K', quality: props.initialQuality ?? defaultImageQuality, imageCandidateCount: props.initialCandidateCount ?? 1 })
  const [numericText, setNumericText] = useState<Record<string, string>>({}), [numericErrors, setNumericErrors] = useState<Record<string, string>>({})
  const [picker, setPicker] = useState<ImageReferenceRole | null>(null), [importing, setImporting] = useState<ImageReferenceRole | null>(null), [resolving, setResolving] = useState<ImageReferenceRole | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const panel = useRef<HTMLElement>(null), alive = useRef(true), submitting = useRef(false), completed = useRef(false), importPending = useRef(false), requestEpoch = useRef(0), initialScope = useRef(props.scopeKey), assetRead = useRef<AbortController | null>(null)
  const current = useRef(props); current.current = props
  const state = useRef({ task, references, views, prompt, autoAnalyze, generation, numericErrors }); state.current = { task, references, views, prompt, autoAnalyze, generation, numericErrors }
  const primary = references[0]?.asset, derived = inspectCommerceTaskSize(task, primary, generation), preset = imageModelPreset(generation.model), resolution = inspectImageResolutionSelection(generation)
  const taskCount = props.mode === 'create' && task.kind === 'product-view' ? views.length : 1
  const editable = !busy && !importing && !resolving
  function active() { return alive.current && current.current.scopeKey === initialScope.current && current.current.isCurrent() }
  function cancelAssetRead() { requestEpoch.current++; assetRead.current?.abort(); assetRead.current = null; if (active()) setResolving(null) }
  function close() { if (!active() || submitting.current) return; cancelAssetRead(); current.current.onClose() }
  function chooseKind(kind: CommerceTaskKind) {
    if (!active() || !editable || props.mode !== 'create') return
    const next = defaultCommerceTask(kind)
    cancelAssetRead(); setPicker(null); setTask(next); setReferences((value) => commerceTaskReferences(next, value)); setNumericText({}); setNumericErrors({}); setError('')
  }
  function updateTask(patch: Partial<CommerceTask>) { if (active() && editable) { const next = { ...state.current.task, ...patch } as CommerceTask; state.current = { ...state.current, task: next }; setTask(next); setError('') } }
  function changeNumber(key: 'strength' | 'upscale', text: string) {
    if (!active() || !editable) return
    setNumericText((value) => ({ ...value, [key]: text }))
    const value = Number(text), min = key === 'upscale' ? 1 : 0, max = key === 'upscale' ? 2 : 1
    const message = !text.trim() || !Number.isFinite(value) || value < min || value > max ? `请输入 ${min}–${max} 之间的数值` : ''
    const errors = { ...state.current.numericErrors, [key]: message }; state.current = { ...state.current, numericErrors: errors }; setNumericErrors(errors)
    if (!message) updateTask({ [key]: value })
  }
  function preserve(value: CommercePreserve, checked: boolean) { updateTask({ preserve: checked ? [...task.preserve, value] : task.preserve.filter((entry) => entry !== value) }) }
  function toggleView(view: CommerceView) { if (active() && editable) setViews((value) => value.includes(view) ? value.filter((entry) => entry !== view) : [...value, view]) }
  function moveView(index: number, direction: -1 | 1) { if (!active() || !editable) return; setViews((value) => { const next = [...value], target = index + direction; if (target < 0 || target >= next.length) return value; [next[index], next[target]] = [next[target], next[index]]; return next }) }
  async function chooseAsset(role: ImageReferenceRole, asset: CanvasImageAssetSummary, importEpoch?: number) {
    if (!active() || submitting.current) throw new Error('创作范围已变化，请重新打开配置')
    if (assetRead.current || (importPending.current && importEpoch === undefined)) throw new Error('正在核对图片，请稍候')
    if (importEpoch !== undefined && importEpoch !== requestEpoch.current) throw new Error('图片选择已取消，请重新选择')
    chooseCommerceTaskAsset(state.current.references, role, asset)
    const epoch = importEpoch ?? ++requestEpoch.current
    const controller = new AbortController()
    assetRead.current = controller
    try {
      let selected = asset
      if (!(Number.isSafeInteger(asset.width) && asset.width! > 0 && Number.isSafeInteger(asset.height) && asset.height! > 0) && current.current.onReadAsset) {
        setResolving(role); setError('')
        selected = await current.current.onReadAsset(asset.assetId, controller.signal)
        if (!active() || requestEpoch.current !== epoch || controller.signal.aborted) throw new Error('图片选择已取消，请重新选择')
        if (!isTemplateImageAsset(selected) || selected.assetId !== asset.assetId) throw new Error('图片详情与所选素材不一致，请重新选择')
        if (!(Number.isSafeInteger(selected.width) && selected.width! > 0 && Number.isSafeInteger(selected.height) && selected.height! > 0)) throw new Error('所选图片的像素尺寸仍未确认，请重新上传或选择其他图片')
      }
      if (!active() || requestEpoch.current !== epoch || controller.signal.aborted) throw new Error('图片选择已取消，请重新选择')
      const next = chooseCommerceTaskAsset(state.current.references, role, selected)
      state.current = { ...state.current, references: next }; setReferences(next); setPicker(null); setError('')
    } catch (cause) {
      if (active() && requestEpoch.current === epoch && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : '图片详情读取失败，请重试')
      throw cause
    } finally {
      if (assetRead.current === controller) { assetRead.current = null; if (active()) setResolving(null) }
    }
  }
  function openPicker(role: ImageReferenceRole) { if (!active() || !editable || assetRead.current || importPending.current) return; cancelAssetRead(); setPicker(role); setError('') }
  function closePicker() { cancelAssetRead(); setPicker(null) }
  async function importAsset(role: ImageReferenceRole) {
    if (!active() || submitting.current || importPending.current || assetRead.current) return
    importPending.current = true; const epoch = ++requestEpoch.current; setImporting(role); setError('')
    try {
      const asset = await current.current.onPickAsset()
      if (!active() || requestEpoch.current !== epoch) return
      if (asset) { if (!isTemplateImageAsset(asset)) throw new Error('请选择已保存的图片素材'); await chooseAsset(role, asset, epoch) }
    } catch (cause) { if (active() && requestEpoch.current === epoch) setError(cause instanceof Error ? cause.message : '上传结果未确认，请先在素材库核对') }
    finally { importPending.current = false; if (active() && requestEpoch.current === epoch) setImporting(null) }
  }
  async function apply() {
    if (!active() || submitting.current || completed.current || importPending.current || assetRead.current) return
    try {
      const value = state.current
      if (Object.values(value.numericErrors).some(Boolean)) throw new Error('请修正参数数值后再保存')
      if (props.mode === 'create' && value.autoAnalyze && current.current.analysisUnavailableReason) throw new Error(current.current.analysisUnavailableReason)
      const draft = buildCommerceTaskSubmission({ ...value, mode: props.mode })
      submitting.current = true; setBusy(true); setError(''); requestEpoch.current++
      await current.current.onApply(draft)
      completed.current = true
      if (active()) current.current.onClose()
    } catch (cause) { if (active()) setError(cause instanceof Error ? cause.message : '配置尚未保存，请保留当前内容并重试') }
    finally { submitting.current = false; if (active()) setBusy(false) }
  }
  function keyboard(event: KeyboardEvent<HTMLElement>) {
    event.stopPropagation()
    if (event.key === 'Escape') { event.preventDefault(); if (picker) closePicker(); else close(); return }
    if (event.key !== 'Tab') return
    const controls = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]') ?? [])].filter((element) => element.getClientRects().length)
    if (event.shiftKey && (document.activeElement === controls[0] || document.activeElement === panel.current)) { event.preventDefault(); controls.at(-1)?.focus() }
    else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus() }
  }
  useEffect(() => { alive.current = true; const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null; panel.current?.focus(); return () => { alive.current = false; cancelAssetRead(); if (previous?.isConnected) previous.focus() } }, [])
  useEffect(() => () => { requestEpoch.current++; assetRead.current?.abort(); assetRead.current = null }, [props.scopeKey])
  const body = <div className="commerce-task-backdrop nodrag nopan nowheel" onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation() }}><section ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label={props.mode === 'create' ? '创建商品与参考图任务' : '编辑商品与参考图任务'} className="commerce-task-dialog" onKeyDown={keyboard}>
    <header><div><small>行业创作 · 参数与素材角色</small><h2><Package size={20} />{commerceTaskLabels[task.kind]}</h2><small>{props.mode === 'create' ? '准备输入，建立可编辑工作流；生成需另行确认。' : '仅修改当前节点；其他视角与共享来源保持独立。'}</small></div><button type="button" disabled={busy} aria-label="关闭创作任务配置" onClick={close}><X size={18} /></button></header>
    {picker ? <div className="commerce-task-picker"><TemplateAssetPicker label={picker === 'source' ? '原始主体图' : '风格参考图'} description="选择本人图片副本绑定此角色，不会生成或先插入画布。" cancelLabel="返回创作任务配置" searchLabel="搜索创作任务参考图片" emptyHint="返回配置后，可上传自己的图片。" fallbackPage={props.assets} onListAssets={props.onListAssets} scopeKey={props.scopeKey} officialAccess={props.officialAccess} onAcquired={props.onAssetAcquired} selected={references.find((entry) => entry.role === picker)?.asset} onChoose={(asset) => chooseAsset(picker, asset)} onCancel={closePicker} /></div> : <div className="commerce-task-scroll"><div className="commerce-task-layout">
      <aside className="commerce-task-assets"><h3>1 · 参考图片</h3>{references.map((reference, index) => <section key={reference.role} className="commerce-task-reference"><header><strong>{reference.role === 'source' ? '原始主体图' : '风格参考图'}</strong><small>模型输入 {index + 1}</small></header><div className="commerce-task-reference-preview">{reference.asset ? <SafeImage src={reference.asset.thumbnailUrl} fallbackSrc={reference.asset.localUrl} alt={reference.label || (reference.role === 'source' ? '原始主体图' : '风格参考图')} /> : <small>{reference.binding.kind === 'existing' ? '来源尚未产出图片' : '等待选择图片'}</small>}</div><p>{reference.label || (reference.binding.kind === 'existing' ? '保留现有连线与批次位置，运行时再次核对' : '请选择或上传一张图片')}</p>{reference.unavailableReason && <p role="alert" className="commerce-task-error">{reference.unavailableReason}</p>}<div className="commerce-task-reference-actions"><button type="button" disabled={!editable} onClick={() => openPicker(reference.role)}><Images size={13} />素材库</button><button type="button" disabled={!editable} onClick={() => void importAsset(reference.role)}>{importing === reference.role ? <LoaderCircle size={13} /> : <Upload size={13} />}上传图片</button></div></section>)}<p>{task.kind === 'style-reference' ? '原图与风格参考图独立绑定；替换其中一张不会互换角色。' : '输入图为主体依据。结果仍需与商品实物核对。'}</p>{task.kind === 'material-a' && <p>创建后可在图像节点添加局部修改蒙版；是否可用取决于模型。</p>}</aside>
      <div className="commerce-task-form"><h3>2 · 创作要求</h3>{props.mode === 'create' && <label className="commerce-task-field"><span>任务类型</span><select aria-label="创作任务类型" value={task.kind} disabled={!editable} onChange={(event) => chooseKind(event.target.value as CommerceTaskKind)}>{Object.entries(commerceTaskLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
        {('strength' in task) && <label className="commerce-task-field"><span>优化强度意图</span><div className="commerce-task-strength"><input type="range" aria-label="优化强度滑杆" min={0} max={1} step={.01} value={task.strength} disabled={!editable} onChange={(event) => changeNumber('strength', event.target.value)} /><input type="number" aria-label="优化强度" min={0} max={1} step={.01} value={numericText.strength ?? task.strength} disabled={!editable} onChange={(event) => changeNumber('strength', event.target.value)} /></div>{numericErrors.strength && <small role="alert" className="commerce-task-error">{numericErrors.strength}</small>}<small>作为可查看的文字指令；不会向模型发送未支持的原生重绘强度参数。</small></label>}
        {task.kind === 'material-b' && <><label className="commerce-task-field"><span>请求尺寸倍率</span><div className="commerce-task-strength"><input type="range" aria-label="请求尺寸倍率滑杆" min={1} max={2} step={.05} value={task.upscale} disabled={!editable} onChange={(event) => changeNumber('upscale', event.target.value)} /><input type="number" aria-label="请求尺寸倍率" min={1} max={2} step={.05} value={numericText.upscale ?? task.upscale} disabled={!editable} onChange={(event) => changeNumber('upscale', event.target.value)} /></div>{numericErrors.upscale && <small role="alert" className="commerce-task-error">{numericErrors.upscale}</small>}</label><div className="commerce-task-note"><strong>{derived.size ? `派生目标尺寸 ${derived.size.replace('x', ' × ')}` : '原图尺寸尚未确认'}</strong><p>原图宽高 × 倍率决定唯一输出尺寸；这是重新生成，不是本地超分。</p>{derived.error && <p role="status" className="commerce-task-error">{derived.error}</p>}</div></>}
        {task.kind === 'style-preset' && <label className="commerce-task-field"><span>原创风格预设</span><select aria-label="原创风格预设" value={task.preset} disabled={!editable} onChange={(event) => updateTask({ preset: event.target.value as typeof task.preset })}>{commerceStylePresets.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}</select></label>}
        {task.kind === 'product-view' && (props.mode === 'edit' ? <label className="commerce-task-field"><span>当前视角</span><select aria-label="当前商品视角" value={task.view} disabled={!editable} onChange={(event) => updateTask({ view: event.target.value as CommerceView })}>{commerceViews.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}</select></label> : <fieldset className="commerce-task-views" disabled={!editable}><legend>商品视角 · 最多 6 个</legend><div className="commerce-task-checks">{commerceViews.map((entry) => <label key={entry.value}><input type="checkbox" checked={views.includes(entry.value)} onChange={() => toggleView(entry.value)} />{entry.label}</label>)}</div><ol className="commerce-task-view-order" aria-label="商品视角顺序">{views.map((view, index) => <li key={view}><small>{index + 1}</small><span>{commerceViews.find((entry) => entry.value === view)?.label}</span><button type="button" aria-label={`前移${commerceViews.find((entry) => entry.value === view)?.label}`} disabled={index === 0} onClick={() => moveView(index, -1)}><ArrowUp size={12} /></button><button type="button" aria-label={`后移${commerceViews.find((entry) => entry.value === view)?.label}`} disabled={index === views.length - 1} onClick={() => moveView(index, 1)}><ArrowDown size={12} /></button></li>)}</ol><small>每个视角是命名独立分支，共用主体参考；不承诺三维一致性。</small></fieldset>)}
        <fieldset className="commerce-task-preserve" disabled={!editable}><legend>优先保持</legend><div className="commerce-task-checks">{commercePreserveOptions.map((entry) => <label key={entry.value}><input type="checkbox" checked={task.preserve.includes(entry.value)} onChange={(event) => preserve(entry.value, event.target.checked)} />{entry.label}</label>)}</div></fieldset>
        {props.mode === 'create' ? <><label className="commerce-task-field"><span>补充要求</span><textarea aria-label="创作补充要求" value={prompt} maxLength={24000} disabled={!editable} placeholder="描述需要变化的材质、光线或商品细节…" onChange={(event) => setPrompt(event.target.value)} /><small>保存在各分支节点的提示词中，之后仍可单独编辑。</small></label><label className="commerce-task-note"><span className="commerce-task-checks"><input type="checkbox" aria-label="添加共享图片分析步骤" checked={autoAnalyze} disabled={!editable || Boolean(props.analysisUnavailableReason)} onChange={(event) => setAutoAnalyze(event.target.checked)} /><strong>先分析参考图片，辅助编写要求</strong></span><p>创建一个可见的文字生成节点，由所有分支共用；运行时增加 1 次文字请求。</p>{props.analysisUnavailableReason && <small>{props.analysisUnavailableReason}</small>}</label><h3>3 · 输出与候选</h3><label className="commerce-task-field"><span>图像模型</span><select aria-label="创作任务图像模型" value={generation.model} disabled={!editable} onChange={(event) => setGeneration((value) => ({ ...value, model: event.target.value }))}>{!props.imageModels.some((entry) => entry.id === generation.model) && <option value={generation.model}>{generation.model ? `${generation.model}（当前来源不可用）` : '暂未配置；保存后在画布选择'}</option>}{props.imageModels.map((entry) => <option key={entry.id} value={entry.id} disabled={!imageModelPreset(entry.id).supportsEdits}>{entry.label}{imageModelPreset(entry.id).supportsEdits ? '' : '（不支持参考图）'}</option>)}</select></label><div className="commerce-task-row"><label className="commerce-task-field"><span>每个任务的候选数量</span><select aria-label="每个任务候选数量" value={generation.imageCandidateCount} disabled={!editable} onChange={(event) => setGeneration((value) => ({ ...value, imageCandidateCount: Number(event.target.value) as ImageCandidateCount }))}>{imageCandidateCounts.map((count) => <option key={count} value={count}>{count} 张</option>)}</select></label>{preset.supportsQuality && <label className="commerce-task-field"><span>画质</span><select aria-label="创作任务画质" value={generation.quality} disabled={!editable} onChange={(event) => setGeneration((value) => ({ ...value, quality: event.target.value }))}>{imageQualityOptions.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}</select></label>}</div>{task.kind !== 'material-b' && <div className="commerce-task-row"><label className="commerce-task-field"><span>画面尺寸</span><select aria-label="创作任务画面尺寸" value={generation.size} disabled={!editable || !generation.model || !preset.supportsSize} onChange={(event) => setGeneration((value) => ({ ...value, size: event.target.value }))}>{!preset.sizes.includes(generation.size) && <option value={generation.size}>{imageSizeLabel(generation.size)}（已保存）</option>}{preset.sizes.map((size) => <option key={size} value={size}>{imageSizeLabel(size)}</option>)}</select></label><label className="commerce-task-field"><span>清晰度</span><select aria-label="创作任务清晰度" value={generation.imageResolution} disabled={!editable || !generation.model} onChange={(event) => setGeneration((value) => ({ ...value, imageResolution: event.target.value as '1K' | '2K' | '4K' }))}>{!generation.model ? <option value={generation.imageResolution}>{generation.imageResolution}</option> : resolution.choices.map((entry) => <option key={entry.value} value={entry.value} disabled={!entry.supported}>{resolution.providerSized && entry.value === '1K' ? '由服务决定' : entry.value}{entry.supported ? '' : '（当前不支持）'}</option>)}</select></label></div>}{task.kind !== 'material-b' && (!generation.model ? <p role="status">配置图像模型后可选择其支持的尺寸与清晰度。</p> : resolution.message && <p role="status">{resolution.message}</p>)}</> : <p className="commerce-task-note">补充说明仍在节点提示词中编辑。模型、候选数量与其他通用参数继续使用节点原配置；此处不会覆盖它们。</p>}
        <details className="commerce-task-prompt-preview"><summary>查看任务指令</summary><p>执行时由保存参数编译；补充说明和上游分析结果另行合并。</p><pre>{(task.kind === 'product-view' && props.mode === 'create' && views.length ? buildCommerceTaskBranches(task, views) : [task]).map((entry) => buildCommerceTaskPrompt(entry, props.mode === 'create' ? prompt : '')).join('\n\n────────\n\n')}</pre></details>
      </div></div></div>}
    <footer><div role={error ? 'alert' : 'status'} className={error ? 'commerce-task-error' : ''}>{error || (busy ? '正在保存创作配置…' : resolving ? '正在核对所选图片的像素尺寸…' : importing ? '正在等待图片上传；关闭不会撤销已提交的上传。' : props.mode === 'create' ? `${taskCount} 个图片任务 × ${generation.imageCandidateCount} 张 = ${taskCount * generation.imageCandidateCount} 次图片请求${autoAnalyze ? '；另有 1 次共享文字分析' : ''}。创建不会运行模型。` : '保存仅更新当前节点配置，可一次撤销。')}</div><div className="commerce-task-footer-actions"><button type="button" disabled={busy} onClick={picker ? closePicker : close}>{picker ? '返回配置' : '取消'}</button>{!picker && <button type="button" className="is-primary" disabled={!editable || Object.values(numericErrors).some(Boolean)} onClick={() => void apply()}>{busy ? <LoaderCircle size={15} /> : <Check size={15} />}{props.mode === 'create' ? '创建到画布' : '保存节点配置'}</button>}</div></footer>
  </section></div>
  return typeof document === 'undefined' ? body : createPortal(body, document.body)
}

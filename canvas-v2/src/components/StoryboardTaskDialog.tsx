import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { PanelsTopLeft, Check, Images, LoaderCircle, Upload, X } from 'lucide-react'
import type { CanvasAssetPage, CanvasAssetSummary, CanvasImageAssetSummary } from '../host'
import { buildStoryboardAnalysisPrompt, buildStoryboardTaskPrompt, storyboardStyleOptions, storyboardPanelOptions, parseStoryboardTask, type StoryboardTask } from '../storyboard/storyboard-task'
import { imageModelPreset, imageQualityOptions, imageSizeLabel, knownNonImageModel } from '../models'
import { imageCandidateCounts } from '../runtime/image-candidate-count'
import { inspectImageResolutionSelection } from '../runtime/image-resolution-selection'
import { textImageInputModelSupported } from '../runtime/text-image-input'
import { SafeImage } from './MediaPreview'
import { TemplateAssetPicker } from './TemplateAssetPicker'
import { isTemplateImageAsset, type TemplateAssetLoader } from './template-asset-picker-model'
import type { OfficialAssetAccess } from './official-asset-browser-model'
import { buildStoryboardTaskSubmission, chooseStoryboardTaskAsset, storyboardTaskDraftKey, storyboardTaskReferenceLabel, storyboardTaskReferences, initialStoryboardAnalysis, initialStoryboardGeneration, addStoryboardTaskReference, removeStoryboardTaskReference, moveStoryboardTaskReference, type StoryboardTaskAnalysisDraft, type StoryboardTaskDialogDraft, type StoryboardTaskForm, type StoryboardTaskGenerationDraft, type StoryboardTaskReferenceDraft } from './storyboard-task-ui'
import './storyboard-task.css'

export type { StoryboardTaskAnalysisDraft, StoryboardTaskDialogDraft, StoryboardTaskGenerationDraft, StoryboardTaskReferenceDraft } from './storyboard-task-ui'
export interface StoryboardTaskDialogProps {
  mode: 'create' | 'edit'
  scopeKey: string
  isCurrent(): boolean
  initialTask: StoryboardTask
  initialReferences?: readonly StoryboardTaskReferenceDraft[]
  initialPrompt?: string
  initialGeneration?: Partial<StoryboardTaskGenerationDraft>
  initialAnalysis?: Partial<StoryboardTaskAnalysisDraft>
  assets: CanvasAssetPage
  onListAssets?: TemplateAssetLoader
  onPickAsset(): Promise<CanvasAssetSummary | null>
  onReadAsset?(assetId: string, signal?: AbortSignal): Promise<CanvasImageAssetSummary>
  officialAccess?: OfficialAssetAccess
  onAssetAcquired?(): void
  imageModels: readonly { id: string; label: string }[]
  textModels: readonly { id: string; label: string }[]
  imageSources?: readonly { id: string; label: string }[]
  textSources?: readonly { id: string; label: string }[]
  imageSource?: string
  textSource?: string
  onSelectSource?(kind: 'image' | 'text', source: string): void
  sourceLoading?: boolean
  imageSourceLoading?: boolean
  textSourceLoading?: boolean
  analysisUnavailableReason?: string
  onApply(draft: StoryboardTaskDialogDraft): Promise<void>
  onClose(): void
}

export function StoryboardTaskDialog(props: StoryboardTaskDialogProps) {
  const [form, setForm] = useState<StoryboardTaskForm>(() => ({ task: { ...props.initialTask }, references: storyboardTaskReferences(props.initialTask, props.initialReferences ?? []), prompt: props.initialPrompt ?? '', generation: initialStoryboardGeneration(props.initialGeneration, props.imageModels), analysis: initialStoryboardAnalysis(props.initialAnalysis ?? (props.mode === 'edit' ? { model: '' } : {}), props.textModels) }))
  const [picker, setPicker] = useState<number | null>(null), [importing, setImporting] = useState<number | null>(null), [resolving, setResolving] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [confirmClose, setConfirmClose] = useState(false), [sourceChanging, setSourceChanging] = useState(false)
  const panel = useRef<HTMLElement>(null), alive = useRef(true), initialScope = useRef(props.scopeKey), initialKey = useRef(storyboardTaskDraftKey(form)), submitting = useRef(false), completed = useRef(false), pickerOpen = useRef<number | null>(null)
  const sourceRequest = useRef<{ kind: 'image' | 'text'; source: string; observedLoading: boolean } | null>(null)
  const request = useRef({ epoch: 0, uploading: false, controller: null as AbortController | null }), state = useRef(form), current = useRef(props)
  state.current = form; current.current = props
  const { task, references, prompt, generation, analysis } = form, preset = imageModelPreset(generation.model), resolution = inspectImageResolutionSelection(generation), automatic = task.automaticPlot
  const manualPromptMissing = !automatic && !prompt.trim()
  const editable = !busy && importing === null && !resolving && !confirmClose
  const imageModels = props.imageModels.filter((model) => !knownNonImageModel(model.id))
  const visionModels = props.textModels.filter((model) => textImageInputModelSupported(model.id))
  const sourceLoading = Boolean(props.sourceLoading || props.imageSourceLoading || automatic && props.textSourceLoading || sourceChanging && (sourceRequest.current?.kind === 'image' || automatic))
  const imageError = !sourceLoading && props.imageSources !== undefined && generation.model && !imageModels.some((model) => model.id === generation.model) ? '原图像模型在当前来源不可用，请重新选择图像模型。' : ''
  const analysisError = automatic ? props.analysisUnavailableReason || (!analysis.model ? '请选择已支持图片理解的文字模型，或关闭自动剧情并填写剧情。' : !visionModels.some((model) => model.id === analysis.model) ? '所选视觉文字模型在当前来源不可用，请重新选择。' : '') : ''
  function active() { return alive.current && current.current.scopeKey === initialScope.current && current.current.isCurrent() }
  function cancelRead() { request.current.epoch++; request.current.controller?.abort(); request.current.controller = null; request.current.uploading = false; if (active()) { setImporting(null); setResolving(false) } }
  function change(patch: Partial<StoryboardTaskForm>) { if (!active() || submitting.current || completed.current || request.current.uploading || request.current.controller || confirmClose) return; const next = { ...state.current, ...patch }; state.current = next; setForm(next); setError('') }
  function updateTask(patch: Record<string, unknown>) { const next = parseStoryboardTask({ ...state.current.task, ...patch }); change({ task: next, references: storyboardTaskReferences(next, state.current.references) }) }
  function updateGeneration(patch: Partial<StoryboardTaskGenerationDraft>) { change({ generation: { ...state.current.generation, ...patch } }) }
  function selectSource(kind: 'image' | 'text', source: string) {
    if (!active() || !editable || submitting.current || completed.current || request.current.uploading || request.current.controller || !current.current.onSelectSource) return
    const sources = kind === 'image' ? current.current.imageSources : current.current.textSources
    if (!sources?.some((entry) => entry.id === source)) { setError('所选模型来源已变化，请重新选择'); return }
    if (source === (kind === 'image' ? current.current.imageSource : current.current.textSource) && !sourceRequest.current) return
    sourceRequest.current = { kind, source, observedLoading: Boolean(current.current.sourceLoading || (kind === 'image' ? current.current.imageSourceLoading : current.current.textSourceLoading)) }; setSourceChanging(true); setError('')
    try { current.current.onSelectSource(kind, source) }
    catch (cause) { sourceRequest.current = null; setSourceChanging(false); setError(cause instanceof Error ? cause.message : '模型来源尚未切换，请重试') }
  }
  function finishClose() { if (!active() || submitting.current) return; pickerOpen.current = null; cancelRead(); current.current.onClose() }
  function close() {
    if (!active() || submitting.current) return
    pickerOpen.current = null; setPicker(null); cancelRead()
    if (storyboardTaskDraftKey(state.current) !== initialKey.current) setConfirmClose(true)
    else current.current.onClose()
  }
  function openPicker(index: number) { if (active() && editable && !submitting.current && !completed.current && !request.current.uploading && !request.current.controller) { request.current.epoch++; pickerOpen.current = index; setPicker(index); setError('') } }
  function closePicker() { pickerOpen.current = null; cancelRead(); setPicker(null) }
  function changeReferences(action: 'add' | 'remove' | 'up' | 'down', index = 0) {
    if (!active() || !editable || submitting.current || completed.current || request.current.uploading || request.current.controller || pickerOpen.current !== null) return
    try { const references = state.current.references; change({ references: action === 'add' ? addStoryboardTaskReference(references) : action === 'remove' ? removeStoryboardTaskReference(references, index) : moveStoryboardTaskReference(references, index, action === 'up' ? -1 : 1) }) }
    catch (cause) { setError(cause instanceof Error ? cause.message : '图片顺序无法修改，请重新核对') }
  }
  async function chooseAsset(index: number, asset: CanvasImageAssetSummary, uploadEpoch?: number, pickerEpoch?: number) {
    if (!active() || submitting.current) throw new Error('创作范围已变化，请重新打开故事板配置')
    if (uploadEpoch === undefined && (pickerOpen.current !== index || pickerEpoch !== request.current.epoch)) throw new Error('图片选择已关闭，请重新打开素材库')
    if (request.current.controller || request.current.uploading && uploadEpoch === undefined) throw new Error('正在核对故事板图片，请稍候')
    if (uploadEpoch !== undefined && uploadEpoch !== request.current.epoch) throw new Error('图片选择已取消，请重新选择')
    chooseStoryboardTaskAsset(state.current.references, index, asset)
    const epoch = uploadEpoch ?? ++request.current.epoch, controller = new AbortController()
    request.current.controller = controller
    try {
      let selected = asset
      if (!(Number.isSafeInteger(asset.width) && asset.width! > 0 && Number.isSafeInteger(asset.height) && asset.height! > 0) && current.current.onReadAsset) {
        setResolving(true); setError('')
        selected = await current.current.onReadAsset(asset.assetId, controller.signal)
        if (!active() || request.current.epoch !== epoch || controller.signal.aborted) throw new Error('图片选择已取消，请重新选择')
        if (!isTemplateImageAsset(selected) || selected.assetId !== asset.assetId) throw new Error('图片详情与所选素材不一致，请重新选择')
      }
      if (!active() || request.current.epoch !== epoch || controller.signal.aborted) throw new Error('图片选择已取消，请重新选择')
      const next = { ...state.current, references: chooseStoryboardTaskAsset(state.current.references, index, selected) }
      state.current = next; setForm(next); pickerOpen.current = null; setPicker(null); setError('')
    } catch (cause) { if (active() && request.current.epoch === epoch && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : '故事板图片读取失败，请重试'); throw cause }
    finally { if (request.current.controller === controller) { request.current.controller = null; if (active()) setResolving(false) } }
  }
  async function importAsset(index: number) {
    if (!active() || submitting.current || request.current.uploading || request.current.controller || confirmClose) return
    const epoch = ++request.current.epoch
    request.current.uploading = true; setImporting(index); setError('')
    try {
      const asset = await current.current.onPickAsset()
      if (!active() || request.current.epoch !== epoch) return
      if (asset) { if (!isTemplateImageAsset(asset)) throw new Error('请选择已保存的故事板图片'); await chooseAsset(index, asset, epoch) }
    } catch (cause) { if (active() && request.current.epoch === epoch) setError(cause instanceof Error ? cause.message : '上传结果未确认，请先在素材库核对') }
    finally { if (request.current.epoch === epoch) { request.current.uploading = false; if (active()) setImporting(null) } }
  }
  async function apply() {
    if (!active() || submitting.current || completed.current || request.current.uploading || request.current.controller || confirmClose) return
    try {
      if (current.current.sourceLoading || current.current.imageSourceLoading || state.current.task.automaticPlot && current.current.textSourceLoading || sourceRequest.current && (sourceRequest.current.kind === 'image' || state.current.task.automaticPlot)) throw new Error('模型来源正在读取，请稍后再保存')
      if (current.current.imageSources !== undefined && state.current.generation.model && !current.current.imageModels.some((model) => model.id === state.current.generation.model)) throw new Error('原图像模型在当前来源不可用，请重新选择图像模型')
      if (state.current.task.automaticPlot) {
        if (current.current.analysisUnavailableReason) throw new Error(current.current.analysisUnavailableReason)
        if (!current.current.textModels.some((model) => model.id === state.current.analysis.model && textImageInputModelSupported(model.id))) throw new Error('所选视觉文字模型在当前来源不可用，请重新选择')
      }
      const draft = buildStoryboardTaskSubmission(current.current.mode, state.current)
      submitting.current = true; setBusy(true); setError(''); request.current.epoch++
      await current.current.onApply(draft)
      completed.current = true
      if (active()) current.current.onClose()
    } catch (cause) { if (active()) setError(cause instanceof Error ? cause.message : '配置尚未保存，请保留草稿并重试') }
    finally { submitting.current = false; if (active()) setBusy(false) }
  }
  function keyboard(event: KeyboardEvent<HTMLElement>) {
    event.stopPropagation()
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Escape') { event.preventDefault(); if (confirmClose) setConfirmClose(false); else if (picker !== null) closePicker(); else close(); return }
    if (event.key !== 'Tab') return
    const root = confirmClose ? panel.current?.querySelector<HTMLElement>('[role="alertdialog"]') : panel.current
    const controls = [...(root?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,[tabindex="0"]') ?? [])].filter((element) => element.getClientRects().length)
    if (event.shiftKey && (document.activeElement === controls[0] || document.activeElement === root)) { event.preventDefault(); controls.at(-1)?.focus() }
    else if (!event.shiftKey && (document.activeElement === controls.at(-1) || !root?.contains(document.activeElement))) { event.preventDefault(); controls[0]?.focus() }
  }
  useEffect(() => { alive.current = true; const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null; panel.current?.focus(); return () => { alive.current = false; cancelRead(); if (previous?.isConnected) previous.focus() } }, [])
  useEffect(() => () => { request.current.epoch++; request.current.controller?.abort(); request.current.controller = null }, [props.scopeKey])
  useEffect(() => {
    const pending = sourceRequest.current
    if (!pending || !active()) return
    if (props.sourceLoading || (pending.kind === 'image' ? props.imageSourceLoading : props.textSourceLoading)) { pending.observedLoading = true; return }
    const selected = pending.kind === 'image' ? props.imageSource : props.textSource
    if (selected === pending.source || pending.observedLoading) {
      sourceRequest.current = null; setSourceChanging(false)
      if (selected !== pending.source) setError('来源尚未切换成功，已保留原配置，请重新选择来源')
    }
  }, [props.sourceLoading, props.imageSourceLoading, props.textSourceLoading, props.imageSource, props.textSource, sourceChanging])
  useEffect(() => { if (confirmClose) panel.current?.querySelector<HTMLButtonElement>('[role="alertdialog"] button')?.focus() }, [confirmClose])
  if (initialScope.current !== props.scopeKey || !props.isCurrent()) return null
  let compiledPrompt: string
  try { compiledPrompt = buildStoryboardTaskPrompt(task, prompt) }
  catch (cause) { compiledPrompt = cause instanceof Error ? cause.message : '请先完善创作要求' }
  const pickerEpoch = request.current.epoch
  const body = <div className="storyboard-task-backdrop nodrag nopan nowheel" onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation() }}><section ref={panel} className="storyboard-task-dialog" role="dialog" aria-modal="true" aria-label={props.mode === 'create' ? '创建故事板创作任务' : '编辑故事板创作任务'} tabIndex={-1} onKeyDown={keyboard}>
    <header><div><small>有序图像叙事 · 故事板创作</small><h2><PanelsTopLeft size={21} />{'图像故事板'}</h2><p>{props.mode === 'create' ? '准备原图和任务参数，保存为可继续编辑的工作流。' : '调整当前节点；原有候选保留，重新运行后才会更新。'}</p></div><button type="button" aria-label="关闭故事板创作配置" disabled={busy} onClick={close}><X size={18} /></button></header>
    {picker !== null ? <div className="storyboard-task-picker"><TemplateAssetPicker label={storyboardTaskReferenceLabel(picker, task)} description="选择本人图片副本绑定此角色；不会自动生成或插入画布。" cancelLabel="返回故事板创作配置" searchLabel="搜索故事板创作图片" emptyHint="返回配置后，可以上传自己的图片。" footerLabel="返回配置" fallbackPage={props.assets} onListAssets={props.onListAssets} officialAccess={props.officialAccess} onAcquired={props.onAssetAcquired} scopeKey={props.scopeKey} selected={references[picker]?.asset} onChoose={(asset) => chooseAsset(picker, asset, undefined, pickerEpoch)} onCancel={closePicker} /></div> : <div className="storyboard-task-scroll"><div className="storyboard-task-layout">
      <aside className="storyboard-task-source"><h3>01 · 有序图片 · {references.length} / 4</h3>{references.map((reference, index) => <section className="storyboard-task-reference" key={index}><header><strong>{storyboardTaskReferenceLabel(index, task)}</strong><small>模型输入 {index + 1}</small></header><div className="storyboard-task-image">{reference.asset ? <SafeImage src={reference.asset.thumbnailUrl} fallbackSrc={reference.asset.localUrl} alt={reference.label || storyboardTaskReferenceLabel(index, task)} /> : <div><Images size={26} /><span>{reference.binding.kind === 'existing' ? '等待现有来源图片' : '选择或上传一张图片'}</span></div>}</div><p>{reference.label || (reference.binding.kind === 'existing' ? '保留现有连线与批次位置' : '尚未绑定图片')}</p>{reference.asset?.width && reference.asset.height && <small>{reference.asset.width} × {reference.asset.height} px</small>}{reference.unavailableReason && <p className="storyboard-task-error" role="alert">{reference.unavailableReason}</p>}<div className="storyboard-task-source-actions"><button type="button" disabled={!editable} onClick={() => openPicker(index)}><Images size={14} />素材库</button><button type="button" disabled={!editable} onClick={() => void importAsset(index)}>{importing === index ? <LoaderCircle size={14} /> : <Upload size={14} />}上传图片</button></div><div className="storyboard-task-source-actions"><button type="button" aria-label={`上移输入 ${index + 1}`} disabled={!editable || index === 0} onClick={() => changeReferences('up', index)}>上移</button><button type="button" aria-label={`下移输入 ${index + 1}`} disabled={!editable || index === references.length - 1} onClick={() => changeReferences('down', index)}>下移</button><button type="button" aria-label={`移除输入 ${index + 1}`} disabled={!editable || references.length === 1} onClick={() => changeReferences('remove', index)}>移除</button></div></section>)}<button type="button" disabled={!editable || references.length >= 4} onClick={() => changeReferences('add')}>添加图片</button><p>当前接入通道支持 1–4 张不同图片。首图作为主叙事依据，其余图片按顺序补充人物或场景。上移或移除首图会重新编号角色；缺失位置不会被别的图片替补。</p><p>原图是角色、场景与视觉关系的依据；剧情与所选画风共同决定每张故事板成图。</p><div className="storyboard-task-note"><strong>先保存配置，再确认运行</strong><p>宫格数是单张成图的布局要求，不是图片请求数量，也不会自动拆图；生成后请核对格数与叙事连续性。</p></div></aside>
      <div className="storyboard-task-form"><h3>02 · 创作任务</h3><fieldset className="storyboard-task-style-options" disabled={!editable}><legend>故事板画风</legend>{storyboardStyleOptions.map((option) => <label key={option.value}><input type="radio" name="storyboard-style" aria-label={option.label} checked={task.style === option.value} onChange={() => updateTask({ style: option.value })} /><strong>{option.label}</strong><small>{option.instruction}</small></label>)}</fieldset>
        <label className="storyboard-task-field"><span>单张成图宫格数</span><select aria-label="故事板宫格数" value={task.panels} disabled={!editable} onChange={(event) => updateTask({ panels: Number(event.target.value) })}>{storyboardPanelOptions.map((panels) => <option key={panels} value={panels}>{panels} 格 · {Math.sqrt(panels)} × {Math.sqrt(panels)}</option>)}</select><small>布局意图由图像模型表达；一次候选是一整张故事板，不保证自动生成精确分隔线，不会自动拆图。</small></label>
        <div className="storyboard-task-note"><label className="storyboard-task-auto"><input type="checkbox" disabled={!editable} checked={task.automaticPlot} onChange={(event) => updateTask({ automaticPlot: event.target.checked })} /><strong>自动剧情</strong></label><p>{automatic ? '会创建可见的图片分析文字节点，按当前顺序读取所有图片与剧情补充，生成可查看的剧情，再交给图像节点。' : '手动描述创作要求，按当前顺序提交已绑定的图片与剧情，不增加文字模型请求。'}</p>{automatic && <>{props.textSources !== undefined && <label className="storyboard-task-field"><span>图片分析文字来源</span><select aria-label="故事板自动剧情文字来源" value={sourceRequest.current?.kind === 'text' ? sourceRequest.current.source : props.textSource ?? ''} disabled={!editable || !props.onSelectSource} onChange={(event) => selectSource('text', event.target.value)}><option value="">请选择文字来源</option>{props.textSource && !props.textSources.some((entry) => entry.id === props.textSource) && <option value={props.textSource}>{props.textSource}（当前不可用）</option>}{props.textSources.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select><small>与画布共用文字来源，选择后立即应用。</small></label>}<label className="storyboard-task-field"><span>图片理解文字模型</span><select aria-label="故事板自动剧情文字模型" value={analysis.model} disabled={!editable} onChange={(event) => change({ analysis: { model: event.target.value } })}><option value="">请选择视觉文字模型</option>{analysis.model && !visionModels.some((model) => model.id === analysis.model) && <option value={analysis.model}>{analysis.model}（当前不可用或不支持图片理解）</option>}{visionModels.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</select></label><p>使用画布的文字来源；运行增加 1 次文字请求，可能产生费用。</p>{analysisError && <p className="storyboard-task-error" role="status">{analysisError}</p>}</>}</div>
        <label className="storyboard-task-field"><span>{!automatic ? '剧情内容 · 必填' : '剧情补充'}</span><textarea aria-label="故事板剧情内容" value={prompt} maxLength={24000} disabled={!editable} placeholder="描述人物、事件、镜头推进或需要保留的情节…" onChange={(event) => change({ prompt: event.target.value })} /><small>{prompt.length} / 24000 · 保存于节点提示词，可继续编辑。</small>{manualPromptMissing && <small className="storyboard-task-error" role="status">手动模式请填写剧情内容。</small>}</label>
        <h3>03 · 模型与输出</h3>{props.imageSources !== undefined && <label className="storyboard-task-field"><span>图像来源</span><select aria-label="故事板创作图像来源" value={sourceRequest.current?.kind === 'image' ? sourceRequest.current.source : props.imageSource ?? ''} disabled={!editable || !props.onSelectSource} onChange={(event) => selectSource('image', event.target.value)}><option value="">请选择图像来源</option>{props.imageSource && !props.imageSources.some((entry) => entry.id === props.imageSource) && <option value={props.imageSource}>{props.imageSource}（当前不可用）</option>}{props.imageSources.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select><small>与画布共用图像来源，选择后立即应用。</small></label>}{sourceLoading && <p role="status">正在读取模型来源…当前任务、图片与要求保持不变，读取完成前不能保存。</p>}<label className="storyboard-task-field"><span>图像模型</span><select aria-label="故事板创作图像模型" value={generation.model} disabled={!editable} onChange={(event) => updateGeneration({ model: event.target.value })}><option value="">进入画布后配置模型</option>{generation.model && !imageModels.some((model) => model.id === generation.model) && <option value={generation.model}>{generation.model}（当前来源不可用，请重新选择）</option>}{imageModels.map((model) => <option key={model.id} value={model.id} disabled={!imageModelPreset(model.id).supportsEdits}>{model.label}{!imageModelPreset(model.id).supportsEdits ? '（不支持参考图）' : ''}</option>)}</select></label>
        <div className="storyboard-task-grid"><label className="storyboard-task-field"><span>画面比例与尺寸</span><select aria-label="故事板创作画面尺寸" value={generation.size} disabled={!editable || !generation.model || !preset.supportsSize} onChange={(event) => updateGeneration({ size: event.target.value })}>{!preset.sizes.includes(generation.size) && <option value={generation.size}>{imageSizeLabel(generation.size)}（已保存）</option>}{preset.sizes.map((size) => <option key={size} value={size}>{imageSizeLabel(size)}</option>)}</select></label><label className="storyboard-task-field"><span>清晰度</span><select aria-label="故事板创作清晰度" value={generation.imageResolution} disabled={!editable || !generation.model} onChange={(event) => updateGeneration({ imageResolution: event.target.value as StoryboardTaskGenerationDraft['imageResolution'] })}>{!generation.model ? <option value={generation.imageResolution}>{generation.imageResolution}</option> : resolution.choices.map((choice) => <option key={choice.value} value={choice.value} disabled={!choice.supported}>{resolution.providerSized && choice.value === '1K' ? '由服务决定' : choice.value}{choice.supported ? '' : '（当前不支持）'}</option>)}</select></label><label className="storyboard-task-field"><span>故事板候选数量</span><select aria-label="故事板创作候选数量" value={generation.imageCandidateCount} disabled={!editable} onChange={(event) => updateGeneration({ imageCandidateCount: Number(event.target.value) as StoryboardTaskGenerationDraft['imageCandidateCount'] })}>{imageCandidateCounts.map((count) => <option key={count} value={count}>{count} 张成图</option>)}</select></label>{preset.supportsQuality && <label className="storyboard-task-field"><span>画质</span><select aria-label="故事板创作画质" value={generation.quality} disabled={!editable} onChange={(event) => updateGeneration({ quality: event.target.value })}>{!imageQualityOptions.some((quality) => quality.value === generation.quality) && <option value={generation.quality}>{generation.quality}（已保存）</option>}{imageQualityOptions.map((quality) => <option key={quality.value} value={quality.value}>{quality.label}</option>)}</select></label>}</div>
        {imageError && <p className="storyboard-task-error" role="status">{imageError}</p>}
        {!generation.model ? <p role="status">图像模型尚待配置；保存不会执行，运行前仍需检查可用来源与参数。</p> : <p role="status" className={!resolution.supported ? 'storyboard-task-error' : ''}>{resolution.message || (resolution.effectiveSize ? `请求尺寸 ${resolution.effectiveSize.replace('x', ' × ')} px` : '输出尺寸由所选模型决定。')}</p>}
        <details className="storyboard-task-prompt"><summary>查看完整创作指令</summary><p>当前参数与补充要求将编译为以下指令；连接的上游文字会在运行时继续合并。</p><pre tabIndex={0}>{compiledPrompt}</pre>{automatic && <><strong>独立图片剧情分析节点的指令</strong><pre tabIndex={0}>{buildStoryboardAnalysisPrompt(task, prompt)}</pre></>}</details>
      </div></div></div>}
    <footer><div role={error ? 'alert' : 'status'} className={error ? 'storyboard-task-error' : ''}>{error || (busy ? '正在保存故事板配置…' : sourceLoading ? '正在读取模型来源，完成后再保存；其他创作要求仍可编辑。' : resolving ? '正在核对所选图片…' : importing !== null ? '等待上传结果；关闭不会撤销已提交的素材上传。' : `${references.length} 张图片输入 · ${generation.imageCandidateCount} 次图片请求（每张要求 ${task.panels} 格）${automatic ? ' + 1 次文字请求' : ' · 0 次文字请求'} · 保存不会运行，生成可能计费。`)}</div><div><button type="button" disabled={busy} onClick={picker !== null ? closePicker : close}>{picker !== null ? '返回配置' : '取消'}</button>{picker === null && <button type="button" className="is-primary" disabled={!editable || sourceLoading || Boolean(imageError) || Boolean(analysisError) || manualPromptMissing} onClick={() => void apply()}>{busy ? <LoaderCircle size={15} /> : <Check size={15} />}{props.mode === 'create' ? '创建故事板任务' : '保存故事板配置'}</button>}</div></footer>
    {confirmClose && <div className="storyboard-task-discard" role="alertdialog" aria-modal="true" aria-label="放弃故事板创作草稿"><strong>保留当前配置继续编辑？</strong><p>尚未保存的修改会在关闭后丢失。已上传图片仍保留在本人素材库。</p><div><button type="button" onClick={() => setConfirmClose(false)}>继续编辑</button><button type="button" onClick={finishClose}>放弃修改并关闭</button></div></div>}
  </section></div>
  return typeof document === 'undefined' ? body : createPortal(body, document.body)
}

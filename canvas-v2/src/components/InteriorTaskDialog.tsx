import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Building2, Check, Images, LoaderCircle, Upload, X } from 'lucide-react'
import type { CanvasAssetPage, CanvasAssetSummary, CanvasImageAssetSummary } from '../host'
import { buildInteriorTaskPrompt, interiorExteriorOptions, interiorFilterOptions, interiorTaskToggleOptions, interiorTimeOptions, interiorWeatherOptions, type InteriorTask } from '../interior/interior-task'
import { imageModelPreset, imageQualityOptions, imageSizeLabel } from '../models'
import { imageCandidateCounts } from '../runtime/image-candidate-count'
import { inspectImageResolutionSelection } from '../runtime/image-resolution-selection'
import { SafeImage } from './MediaPreview'
import { TemplateAssetPicker } from './TemplateAssetPicker'
import { isTemplateImageAsset, type TemplateAssetLoader } from './template-asset-picker-model'
import type { OfficialAssetAccess } from './official-asset-browser-model'
import { buildInteriorTaskSubmission, chooseInteriorTaskAsset, initialInteriorGeneration, interiorTaskDraftKey, type InteriorTaskDialogDraft, type InteriorTaskForm, type InteriorTaskGenerationDraft, type InteriorTaskSourceDraft } from './interior-task-ui'
import './interior-task.css'

export type { InteriorTaskDialogDraft, InteriorTaskGenerationDraft, InteriorTaskSourceDraft } from './interior-task-ui'
export interface InteriorTaskDialogProps {
  mode: 'create' | 'edit'
  scopeKey: string
  isCurrent(): boolean
  initialTask: InteriorTask
  initialSource?: InteriorTaskSourceDraft
  initialPrompt?: string
  initialGeneration?: Partial<InteriorTaskGenerationDraft>
  assets: CanvasAssetPage
  onListAssets?: TemplateAssetLoader
  onPickAsset(): Promise<CanvasAssetSummary | null>
  onReadAsset?(assetId: string, signal?: AbortSignal): Promise<CanvasImageAssetSummary>
  officialAccess?: OfficialAssetAccess
  onAssetAcquired?(): void
  imageModels: readonly { id: string; label: string }[]
  onApply(draft: InteriorTaskDialogDraft): Promise<void>
  onClose(): void
}

export function InteriorTaskDialog(props: InteriorTaskDialogProps) {
  const [form, setForm] = useState<InteriorTaskForm>(() => ({ task: { ...props.initialTask }, source: props.initialSource ?? { binding: { kind: 'missing' } }, prompt: props.initialPrompt ?? '', generation: initialInteriorGeneration(props.initialGeneration, props.imageModels) }))
  const [picker, setPicker] = useState(false), [importing, setImporting] = useState(false), [resolving, setResolving] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [confirmClose, setConfirmClose] = useState(false)
  const panel = useRef<HTMLElement>(null), alive = useRef(true), initialScope = useRef(props.scopeKey), initialKey = useRef(interiorTaskDraftKey(form)), submitting = useRef(false), completed = useRef(false), pickerOpen = useRef(false)
  const request = useRef({ epoch: 0, uploading: false, controller: null as AbortController | null }), state = useRef(form), current = useRef(props)
  state.current = form; current.current = props
  const { task, source, prompt, generation } = form, preset = imageModelPreset(generation.model), resolution = inspectImageResolutionSelection(generation)
  const editable = !busy && !importing && !resolving && !confirmClose
  function active() { return alive.current && current.current.scopeKey === initialScope.current && current.current.isCurrent() }
  function cancelRead() { request.current.epoch++; request.current.controller?.abort(); request.current.controller = null; request.current.uploading = false; if (active()) { setImporting(false); setResolving(false) } }
  function change(patch: Partial<InteriorTaskForm>) { if (!active() || submitting.current || completed.current || request.current.uploading || request.current.controller || confirmClose) return; const next = { ...state.current, ...patch }; state.current = next; setForm(next); setError('') }
  function updateTask(patch: Partial<InteriorTask>) { change({ task: { ...state.current.task, ...patch } }) }
  function updateGeneration(patch: Partial<InteriorTaskGenerationDraft>) { change({ generation: { ...state.current.generation, ...patch } }) }
  function finishClose() { if (!active() || submitting.current) return; pickerOpen.current = false; cancelRead(); current.current.onClose() }
  function close() {
    if (!active() || submitting.current) return
    pickerOpen.current = false; setPicker(false); cancelRead()
    if (interiorTaskDraftKey(state.current) !== initialKey.current) setConfirmClose(true)
    else current.current.onClose()
  }
  function openPicker() { if (active() && editable && !submitting.current && !completed.current && !request.current.uploading && !request.current.controller) { pickerOpen.current = true; setPicker(true); setError('') } }
  function closePicker() { pickerOpen.current = false; cancelRead(); setPicker(false) }
  async function chooseAsset(asset: CanvasImageAssetSummary, uploadEpoch?: number) {
    if (!active() || submitting.current) throw new Error('创作范围已变化，请重新打开室内配置')
    if (uploadEpoch === undefined && !pickerOpen.current) throw new Error('图片选择已关闭，请重新打开素材库')
    if (request.current.controller || request.current.uploading && uploadEpoch === undefined) throw new Error('正在核对室内图片，请稍候')
    if (uploadEpoch !== undefined && uploadEpoch !== request.current.epoch) throw new Error('图片选择已取消，请重新选择')
    chooseInteriorTaskAsset(asset)
    const epoch = uploadEpoch ?? ++request.current.epoch, controller = new AbortController()
    request.current.controller = controller
    try {
      let selected = asset
      if (!(Number.isSafeInteger(asset.width) && asset.width! > 0 && Number.isSafeInteger(asset.height) && asset.height! > 0) && current.current.onReadAsset) {
        setResolving(true); setError('')
        selected = await current.current.onReadAsset(asset.assetId, controller.signal)
        if (!active() || request.current.epoch !== epoch || controller.signal.aborted) throw new Error('图片选择已取消，请重新选择')
        if (!isTemplateImageAsset(selected) || selected.assetId !== asset.assetId) throw new Error('图片详情与所选原图不一致，请重新选择')
      }
      if (!active() || request.current.epoch !== epoch || controller.signal.aborted) throw new Error('图片选择已取消，请重新选择')
      const next = { ...state.current, source: chooseInteriorTaskAsset(selected) }
      state.current = next; setForm(next); pickerOpen.current = false; setPicker(false); setError('')
    } catch (cause) { if (active() && request.current.epoch === epoch && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : '室内图片读取失败，请重试'); throw cause }
    finally { if (request.current.controller === controller) { request.current.controller = null; if (active()) setResolving(false) } }
  }
  async function importAsset() {
    if (!active() || submitting.current || request.current.uploading || request.current.controller || confirmClose) return
    const epoch = ++request.current.epoch
    request.current.uploading = true; setImporting(true); setError('')
    try {
      const asset = await current.current.onPickAsset()
      if (!active() || request.current.epoch !== epoch) return
      if (asset) { if (!isTemplateImageAsset(asset)) throw new Error('请选择已保存的室内图片'); await chooseAsset(asset, epoch) }
    } catch (cause) { if (active() && request.current.epoch === epoch) setError(cause instanceof Error ? cause.message : '上传结果未确认，请先在素材库核对') }
    finally { if (request.current.epoch === epoch) { request.current.uploading = false; if (active()) setImporting(false) } }
  }
  async function apply() {
    if (!active() || submitting.current || completed.current || request.current.uploading || request.current.controller || confirmClose) return
    try {
      const draft = buildInteriorTaskSubmission(current.current.mode, state.current)
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
    if (event.key === 'Escape') { event.preventDefault(); if (confirmClose) setConfirmClose(false); else if (picker) closePicker(); else close(); return }
    if (event.key !== 'Tab') return
    const root = confirmClose ? panel.current?.querySelector<HTMLElement>('[role="alertdialog"]') : panel.current
    const controls = [...(root?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,[tabindex="0"]') ?? [])].filter((element) => element.getClientRects().length)
    if (event.shiftKey && (document.activeElement === controls[0] || document.activeElement === root)) { event.preventDefault(); controls.at(-1)?.focus() }
    else if (!event.shiftKey && (document.activeElement === controls.at(-1) || !root?.contains(document.activeElement))) { event.preventDefault(); controls[0]?.focus() }
  }
  useEffect(() => { alive.current = true; const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null; panel.current?.focus(); return () => { alive.current = false; cancelRead(); if (previous?.isConnected) previous.focus() } }, [])
  useEffect(() => () => { request.current.epoch++; request.current.controller?.abort(); request.current.controller = null }, [props.scopeKey])
  useEffect(() => { if (confirmClose) panel.current?.querySelector<HTMLButtonElement>('[role="alertdialog"] button')?.focus() }, [confirmClose])
  if (initialScope.current !== props.scopeKey || !props.isCurrent()) return null
  const body = <div className="interior-task-backdrop nodrag nopan nowheel" onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation() }}><section ref={panel} className="interior-task-dialog" role="dialog" aria-modal="true" aria-label={props.mode === 'create' ? '创建室内渲染任务' : '编辑室内渲染任务'} tabIndex={-1} onKeyDown={keyboard}>
    <header><div><small>建筑与空间 · 专用创作</small><h2><Building2 size={21} />室内一键渲染</h2><p>{props.mode === 'create' ? '从一张原图开始，准备空间与光线方案。' : '调整当前节点；原有结果保留，重新运行后才会更新。'}</p></div><button type="button" aria-label="关闭室内渲染配置" disabled={busy} onClick={close}><X size={18} /></button></header>
    {picker ? <div className="interior-task-picker"><TemplateAssetPicker label="室内原图" description="选择本人图片副本作为唯一原图；不会生成或先插入画布。" cancelLabel="返回室内渲染配置" searchLabel="搜索室内原图" emptyHint="返回配置后，可以上传一张自己的室内图片。" footerLabel="返回配置" fallbackPage={props.assets} onListAssets={props.onListAssets} officialAccess={props.officialAccess} onAcquired={props.onAssetAcquired} scopeKey={props.scopeKey} selected={source.asset} onChoose={(asset) => chooseAsset(asset)} onCancel={closePicker} /></div> : <div className="interior-task-scroll"><div className="interior-task-layout">
      <aside className="interior-task-source"><h3>01 · 室内原图</h3><div className="interior-task-image">{source.asset ? <SafeImage src={source.asset.thumbnailUrl} fallbackSrc={source.asset.localUrl} alt={source.label || '室内原图'} /> : <div><Images size={30} /><span>{source.binding.kind === 'existing' ? '等待现有来源图片' : '选择或上传一张图片'}</span></div>}</div><strong>{source.label || (source.binding.kind === 'existing' ? '保留现有来源与批次位置' : '尚未绑定原图')}</strong>{source.asset?.width && source.asset.height && <small>{source.asset.width} × {source.asset.height} px</small>}{source.unavailableReason && <p className="interior-task-error" role="alert">{source.unavailableReason}</p>}<div className="interior-task-source-actions"><button type="button" disabled={!editable} onClick={openPicker}><Images size={14} />从素材库选择</button><button type="button" disabled={!editable} onClick={() => void importAsset()}>{importing ? <LoaderCircle size={14} /> : <Upload size={14} />}上传图片</button></div><p>以原图的空间结构、门窗、透视与主要构图为依据。生成后仍需核对建筑关系与细节。</p><div className="interior-task-note"><strong>先保存配置，再确认运行</strong><p>所有选项都编译为可查看的文字指令，不会执行本地灯光或像素滤镜。</p></div></aside>
      <div className="interior-task-form"><h3>02 · 空间与氛围</h3><fieldset className="interior-task-toggles" disabled={!editable}><legend>空间细节</legend>{interiorTaskToggleOptions.map((option) => <label key={option.key}><input type="checkbox" checked={task[option.key]} onChange={(event) => updateTask({ [option.key]: event.target.checked })} /><span>{option.label}</span></label>)}</fieldset><small>关闭开关或选择“无”表示不新增这项要求，不会要求删除原有内容。</small>
        <div className="interior-task-grid">{([{ key: 'weather', label: '天气', options: interiorWeatherOptions }, { key: 'time', label: '时间', options: interiorTimeOptions }, { key: 'exterior', label: '外景', options: interiorExteriorOptions }, { key: 'filter', label: '滤镜方向', options: interiorFilterOptions }] as const).map((field) => <label className="interior-task-field" key={field.key}><span>{field.label}</span><select aria-label={`室内${field.label}`} disabled={!editable} value={task[field.key]} onChange={(event) => updateTask({ [field.key]: event.target.value })}>{field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>)}</div>
        <label className="interior-task-field"><span>补充要求</span><textarea aria-label="室内渲染补充要求" value={prompt} maxLength={24000} disabled={!editable} placeholder="描述空间用途、材质、需要保留的家具与细节…" onChange={(event) => change({ prompt: event.target.value })} /><small>{prompt.length} / 24000 · 保存在节点提示词中，可继续编辑。</small></label>
        <h3>03 · 模型与输出</h3><label className="interior-task-field"><span>图像模型</span><select aria-label="室内渲染图像模型" value={generation.model} disabled={!editable} onChange={(event) => updateGeneration({ model: event.target.value })}><option value="">{props.mode === 'edit' ? '继承画布生成配置' : '进入画布后选择模型'}</option>{generation.model && !props.imageModels.some((model) => model.id === generation.model) && <option value={generation.model}>{generation.model}（当前来源不可用）</option>}{props.imageModels.map((model) => <option key={model.id} value={model.id} disabled={!imageModelPreset(model.id).supportsEdits}>{model.label}{!imageModelPreset(model.id).supportsEdits ? '（不支持参考图）' : ''}</option>)}</select></label>
        <div className="interior-task-grid"><label className="interior-task-field"><span>画面比例与尺寸</span><select aria-label="室内渲染画面尺寸" value={generation.size} disabled={!editable || !generation.model || !preset.supportsSize} onChange={(event) => updateGeneration({ size: event.target.value })}>{!preset.sizes.includes(generation.size) && <option value={generation.size}>{imageSizeLabel(generation.size)}（已保存）</option>}{preset.sizes.map((size) => <option key={size} value={size}>{imageSizeLabel(size)}</option>)}</select></label><label className="interior-task-field"><span>清晰度</span><select aria-label="室内渲染清晰度" value={generation.imageResolution} disabled={!editable || !generation.model} onChange={(event) => updateGeneration({ imageResolution: event.target.value as InteriorTaskGenerationDraft['imageResolution'] })}>{!generation.model ? <option value={generation.imageResolution}>{generation.imageResolution}</option> : resolution.choices.map((choice) => <option key={choice.value} value={choice.value} disabled={!choice.supported}>{resolution.providerSized && choice.value === '1K' ? '由服务决定' : choice.value}{choice.supported ? '' : '（当前不支持）'}</option>)}</select></label><label className="interior-task-field"><span>候选数量</span><select aria-label="室内渲染候选数量" value={generation.imageCandidateCount} disabled={!editable} onChange={(event) => updateGeneration({ imageCandidateCount: Number(event.target.value) as InteriorTaskGenerationDraft['imageCandidateCount'] })}>{imageCandidateCounts.map((count) => <option key={count} value={count}>{count} 张</option>)}</select></label>{preset.supportsQuality && <label className="interior-task-field"><span>画质</span><select aria-label="室内渲染画质" value={generation.quality} disabled={!editable} onChange={(event) => updateGeneration({ quality: event.target.value })}>{!imageQualityOptions.some((quality) => quality.value === generation.quality) && <option value={generation.quality}>{generation.quality}（已保存）</option>}{imageQualityOptions.map((quality) => <option key={quality.value} value={quality.value}>{quality.label}</option>)}</select></label>}</div>
        {!generation.model ? <p role="status">继承画布生成配置；选择具体模型后可核对支持的尺寸与清晰度。</p> : <p role="status" className={!resolution.supported ? 'interior-task-error' : ''}>{resolution.message || (resolution.effectiveSize ? `请求尺寸 ${resolution.effectiveSize.replace('x', ' × ')} px` : '输出尺寸由所选模型决定。')}</p>}
        <details className="interior-task-prompt"><summary>查看完整渲染指令</summary><p>执行时使用这份参数指令与补充要求；已连接的文字输入将继续按现有流程合并。</p><pre tabIndex={0}>{buildInteriorTaskPrompt(task, prompt)}</pre></details>
      </div></div></div>}
    <footer><div role={error ? 'alert' : 'status'} className={error ? 'interior-task-error' : ''}>{error || (busy ? '正在保存室内配置…' : resolving ? '正在核对所选图片…' : importing ? '等待上传结果；关闭不会撤销已提交的素材上传。' : `${generation.imageCandidateCount} 张候选 · 保存配置不会运行模型。`)}</div><div><button type="button" disabled={busy} onClick={picker ? closePicker : close}>{picker ? '返回配置' : '取消'}</button>{!picker && <button type="button" className="is-primary" disabled={!editable} onClick={() => void apply()}>{busy ? <LoaderCircle size={15} /> : <Check size={15} />}{props.mode === 'create' ? '创建室内任务' : '保存室内配置'}</button>}</div></footer>
    {confirmClose && <div className="interior-task-discard" role="alertdialog" aria-modal="true" aria-label="放弃室内创作草稿"><strong>保留当前配置继续编辑？</strong><p>尚未保存的修改会在关闭后丢失。已经上传的图片仍保留在本人素材库。</p><div><button type="button" onClick={() => setConfirmClose(false)}>继续编辑</button><button type="button" onClick={finishClose}>放弃修改并关闭</button></div></div>}
  </section></div>
  return typeof document === 'undefined' ? body : createPortal(body, document.body)
}

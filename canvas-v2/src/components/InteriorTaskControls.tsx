import { Columns2, House, Settings2 } from 'lucide-react'
import { parseImageReferenceOrder, resolveImageReferenceSlots } from '../commerce/image-reference-order'
import { assertInteriorTaskConfiguration, buildInteriorTaskPrompt, interiorExteriorOptions, interiorFilterOptions, interiorTaskToggleOptions, interiorTimeOptions, interiorWeatherOptions, parseInteriorTask, type InteriorTask } from '../interior/interior-task'
import type { UpstreamMediaReference } from './upstream-references'
import './interior-task-controls.css'

interface InteriorTaskInspection {
  task?: InteriorTask
  sourceState: 'ready' | 'waiting' | 'missing'
  sourceLabel: string
  prompt: string
  error: string
}

export function inspectInteriorTaskControls(settings: Record<string, unknown> | undefined, references: readonly UpstreamMediaReference[], supplement: string): InteriorTaskInspection {
  const result: InteriorTaskInspection = { sourceState: 'missing', sourceLabel: '唯一原图尚未绑定', prompt: '', error: '' }
  if (settings?.interiorTask === undefined) return result
  try {
    const task = parseInteriorTask(settings.interiorTask)
    result.task = task
    result.prompt = buildInteriorTaskPrompt(task, supplement)
    const order = settings.imageReferenceOrder === undefined ? undefined : parseImageReferenceOrder(settings.imageReferenceOrder)
    assertInteriorTaskConfiguration(task, order, settings.commerceTask)
    const selected = resolveImageReferenceSlots(references, order)[0]
    if (!selected || selected.missing) {
      result.sourceLabel = '原图绑定已失效，请重新配置'
    } else if (selected.pending) {
      result.sourceState = 'waiting'
      result.sourceLabel = `${selected.reference?.label || '原图'} · 等待上游图片`
    } else if (selected.reference?.asset?.kind === 'image' && selected.reference.asset.assetId) {
      result.sourceState = 'ready'
      result.sourceLabel = `${selected.reference.label || '原图'} · 图片已就绪`
    } else {
      result.sourceLabel = '原图素材不可用，请重新配置'
    }
    const boundEdge = order?.slots[0]
    if (references.some((reference) => reference.kind === 'image' && (!boundEdge || !('edgeId' in boundEdge) || reference.edgeId !== boundEdge.edgeId))) {
      result.error = '有新接入的图片未分配为唯一原图，请打开室内配置核对；不会自动替换原图。'
    }
    return result
  } catch (cause) {
    return { ...result, error: cause instanceof Error ? cause.message : '室内创作配置无法读取，请重新配置' }
  }
}

export function InteriorTaskControls({ settings, references, prompt, disabled, candidateCount = 0, onEdit, onCompare }: {
  settings?: Record<string, unknown>
  references: readonly UpstreamMediaReference[]
  prompt: string
  disabled?: boolean
  candidateCount?: number
  onEdit?: () => void
  onCompare?: () => void
}) {
  if (settings?.interiorTask === undefined) return null
  const inspected = inspectInteriorTaskControls(settings, references, prompt), task = inspected.task
  return <section className="interior-task-node nodrag nowheel" aria-label="室内渲染任务配置">
    <header><strong><House size={14} aria-hidden="true" />{task ? '室内一键渲染' : '室内配置待修复'}</strong><button type="button" disabled={disabled || !onEdit} onClick={() => { if (!disabled) onEdit?.() }}><Settings2 size={13} aria-hidden="true" />配置室内任务</button></header>
    {task && <>
      <ul className="interior-task-node-toggles" aria-label="室内创作开关">{interiorTaskToggleOptions.map((option) => <li key={option.key} data-enabled={task[option.key]}><span>{option.label}</span><b>{task[option.key] ? '开启' : '未指定'}</b></li>)}</ul>
      <dl className="interior-task-node-environment">
        <div><dt>天气</dt><dd>{interiorWeatherOptions.find((option) => option.value === task.weather)?.label}</dd></div>
        <div><dt>时间</dt><dd>{interiorTimeOptions.find((option) => option.value === task.time)?.label}</dd></div>
        <div><dt>窗外环境</dt><dd>{interiorExteriorOptions.find((option) => option.value === task.exterior)?.label}</dd></div>
        <div><dt>风格方向</dt><dd>{interiorFilterOptions.find((option) => option.value === task.filter)?.label}</dd></div>
      </dl>
    </>}
    <p className={`interior-task-node-source is-${inspected.sourceState}`} role="status"><strong>唯一原图</strong><span>{inspected.sourceLabel}</span></p>
    {inspected.error && <p className="interior-task-node-error" role="status">{inspected.error}</p>}
    {task && <details className="interior-task-node-instructions"><summary>查看完整创作指令</summary><pre tabIndex={0} aria-label="当前节点的室内创作指令">{inspected.prompt}</pre><small>由当前室内选项和补充要求编译；连接的上游文字会在运行时一并使用。原图可读性会在运行前核对。</small></details>}
    {candidateCount >= 2 && onCompare && <button type="button" disabled={disabled} onClick={() => { if (!disabled) onCompare() }}><Columns2 size={13} aria-hidden="true" />对比室内候选（{candidateCount} 张）</button>}
  </section>
}

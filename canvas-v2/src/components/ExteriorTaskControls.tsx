import { Building2, Columns2, Settings2 } from 'lucide-react'
import { parseImageReferenceOrder, resolveImageReferenceSlots, type ImageReferenceRole } from '../commerce/image-reference-order'
import { assertExteriorTaskConfiguration, buildExteriorAnalysisPrompt, buildExteriorTaskPrompt, exteriorTaskLabels, exteriorTaskRoles, exteriorTaskUsesAnalysis, exteriorTaskToggleOptions, exteriorLightTemperatureOptions, exteriorWeatherOptions, exteriorTimeOptions, exteriorEnvironmentOptions, exteriorDistantOptions, parseExteriorTask, type ExteriorTask } from '../exterior/exterior-task'
import type { UpstreamMediaReference } from './upstream-references'
import { exteriorTaskReferenceLabel } from './exterior-task-ui'
import './exterior-task-controls.css'

interface ExteriorTaskInspection {
  task?: ExteriorTask
  sources: { role: ImageReferenceRole; state: 'ready' | 'waiting' | 'missing'; label: string }[]
  prompt: string
  error: string
}
export function inspectExteriorTaskControls(settings: Record<string, unknown> | undefined, references: readonly UpstreamMediaReference[], supplement: string): ExteriorTaskInspection {
  const result: ExteriorTaskInspection = { sources: [], prompt: '', error: '' }
  if (settings?.exteriorTask === undefined) return result
  try {
    const task = parseExteriorTask(settings.exteriorTask)
    result.task = task
    result.prompt = buildExteriorTaskPrompt(task, supplement)
    const order = settings.imageReferenceOrder === undefined ? undefined : parseImageReferenceOrder(settings.imageReferenceOrder)
    assertExteriorTaskConfiguration(task, order, settings.commerceTask, settings.interiorTask)
    const slots = resolveImageReferenceSlots(references, order), ids = new Set<string>()
    result.sources = exteriorTaskRoles(task).map((role, index) => {
      const selected = slots[index]
      if (!selected || selected.missing) return { role, state: 'missing', label: '绑定已失效，请重新配置' }
      if (selected.pending) return { role, state: 'waiting', label: `${selected.reference?.label || exteriorTaskReferenceLabel(role, task)} · 等待上游图片` }
      const asset = selected.reference?.asset
      if (asset?.kind !== 'image' || !asset.assetId) return { role, state: 'missing', label: '素材不可用，请重新配置' }
      if (ids.has(asset.assetId)) throw new Error('建筑原图和参考图必须使用不同的实际图片')
      ids.add(asset.assetId)
      return { role, state: 'ready', label: `${selected.reference?.label || exteriorTaskReferenceLabel(role, task)} · 图片已就绪` }
    })
    const boundEdges = new Set(order?.slots.flatMap((slot) => 'edgeId' in slot ? [slot.edgeId] : []))
    if (references.some((reference) => reference.kind === 'image' && !boundEdges.has(reference.edgeId))) result.error = '有新接入的图片尚未分配角色，请打开室外配置核对；不会自动替换原图或参考图。'
    if ('automaticPrompt' in task && !task.automaticPrompt && !supplement.trim()) result.error = '手动模式的创作要求为空，请补充后再运行。'
    return result
  } catch (cause) { return { ...result, error: cause instanceof Error ? cause.message : '室外配置无法读取，请重新配置' } }
}

export function ExteriorTaskControls({ settings, references, prompt, disabled, candidateCount = 0, requestCandidateCount = 1, onEdit, onCompare }: {
  settings?: Record<string, unknown>
  references: readonly UpstreamMediaReference[]
  prompt: string
  disabled?: boolean
  candidateCount?: number
  requestCandidateCount?: number
  onEdit?: () => void
  onCompare?: () => void
}) {
  if (settings?.exteriorTask === undefined) return null
  const inspected = inspectExteriorTaskControls(settings, references, prompt), task = inspected.task
  return <section className="exterior-task-node nodrag nowheel" aria-label="室外创作任务配置">
    <header><strong><Building2 size={14} aria-hidden="true" />{task ? exteriorTaskLabels[task.kind] : '室外配置待修复'}</strong><button type="button" disabled={disabled || !onEdit} onClick={() => { if (!disabled) onEdit?.() }}><Settings2 size={13} aria-hidden="true" />配置室外任务</button></header>
    {task?.kind === 'exterior-render' && <><ul className="exterior-task-node-toggles" aria-label="室外创作开关">{exteriorTaskToggleOptions.map((option) => <li key={option.key} data-enabled={task[option.key]}><span>{option.label}</span><b>{task[option.key] ? '开启' : '未指定'}</b></li>)}</ul><dl className="exterior-task-node-environment"><div><dt>灯光色温</dt><dd>{task.interiorLighting ? exteriorLightTemperatureOptions.find((option) => option.value === task.lightTemperature)?.label : '未指定（室内灯光关闭）'}</dd></div><div><dt>天气</dt><dd>{exteriorWeatherOptions.find((option) => option.value === task.weather)?.label}</dd></div><div><dt>时间</dt><dd>{exteriorTimeOptions.find((option) => option.value === task.time)?.label}</dd></div><div><dt>环境</dt><dd>{exteriorEnvironmentOptions.find((option) => option.value === task.environment)?.label}</dd></div><div><dt>远景</dt><dd>{exteriorDistantOptions.find((option) => option.value === task.distant)?.label}</dd></div></dl></>}
    {task?.kind === 'exterior-redraw' && <p>色调参考：{task.useToneReference ? '开启 · 需要独立参考图' : '未启用 · 仅建筑原图'}</p>}
    {task && 'automaticPrompt' in task && <p>提示模式：{task.automaticPrompt ? '自动 · 独立图片分析文字节点' : '手动 · 使用已填写创作要求'}</p>}
    {inspected.sources.map((source) => <p key={source.role} className={`exterior-task-node-source is-${source.state}`} role="status"><strong>{exteriorTaskReferenceLabel(source.role, task)}</strong><span>{source.label}</span></p>)}
    {inspected.error && <p className="exterior-task-node-error" role="status">{inspected.error}</p>}
    {task && <><p className="exterior-task-node-requests">{exteriorTaskRoles(task).length} 张输入 · {requestCandidateCount} 次图片请求{exteriorTaskUsesAnalysis(task) ? ' + 1 次文字请求（含图片分析）' : ' · 0 次文字请求'}。以运行预检为准，生成可能计费。</p><details className="exterior-task-node-instructions"><summary>查看完整创作指令</summary><pre tabIndex={0} aria-label="当前节点的室外创作指令">{inspected.prompt}</pre>{exteriorTaskUsesAnalysis(task) && <><strong>独立分析节点的指令</strong><pre tabIndex={0}>{buildExteriorAnalysisPrompt(task)}</pre></>}<small>选项通过文字指令表达；连接的上游文字会在运行时合并。原图、参考图与模型可用性会在运行前核对。</small></details></>}
    {candidateCount >= 2 && onCompare && <button type="button" disabled={disabled} onClick={() => { if (!disabled) onCompare() }}><Columns2 size={13} aria-hidden="true" />对比室外候选（{candidateCount} 张）</button>}
  </section>
}

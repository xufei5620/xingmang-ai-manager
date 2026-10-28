import { Columns2, PanelsTopLeft, Settings2 } from 'lucide-react'
import { parseImageReferenceOrder, resolveImageReferenceSlots } from '../commerce/image-reference-order'
import { assertStoryboardTaskConfiguration, buildStoryboardAnalysisPrompt, buildStoryboardTaskPrompt, parseStoryboardTask, storyboardStyleOptions, type StoryboardTask } from '../storyboard/storyboard-task'
import type { UpstreamMediaReference } from './upstream-references'
import { storyboardTaskReferenceLabel } from './storyboard-task-ui'
import './storyboard-task-controls.css'

interface StoryboardTaskInspection { task?: StoryboardTask; sources: { index: number; state: 'ready' | 'waiting' | 'missing'; label: string }[]; prompt: string; error: string }
export function inspectStoryboardTaskControls(settings: Record<string, unknown> | undefined, references: readonly UpstreamMediaReference[], supplement: string): StoryboardTaskInspection {
  const result: StoryboardTaskInspection = { sources: [], prompt: '', error: '' }
  if (settings?.storyboardTask === undefined) return result
  try {
    const task = parseStoryboardTask(settings.storyboardTask)
    result.task = task; result.prompt = buildStoryboardTaskPrompt(task, supplement)
    const order = settings.imageReferenceOrder === undefined ? undefined : parseImageReferenceOrder(settings.imageReferenceOrder)
    assertStoryboardTaskConfiguration(task, order, settings.commerceTask, settings.interiorTask, settings.exteriorTask)
    const slots = resolveImageReferenceSlots(references, order), ids = new Set<string>()
    result.sources = slots.map((slot, index) => {
      if (slot.missing) return { index, state: 'missing', label: '绑定已失效，请重新配置；不会自动替补' }
      if (slot.pending) return { index, state: 'waiting', label: `${slot.reference?.label || storyboardTaskReferenceLabel(index)} · 等待上游图片` }
      const asset = slot.reference?.asset
      if (asset?.kind !== 'image' || !asset.assetId) return { index, state: 'missing', label: '素材不可用，请重新配置' }
      if (ids.has(asset.assetId)) throw new Error('故事图片不能重复使用同一张实际素材')
      ids.add(asset.assetId)
      return { index, state: 'ready', label: `${slot.reference?.label || storyboardTaskReferenceLabel(index)} · 图片已就绪` }
    })
    const bound = new Set(order?.slots.flatMap((slot) => 'edgeId' in slot ? [slot.edgeId] : []))
    if (references.some((reference) => reference.kind === 'image' && !bound.has(reference.edgeId))) result.error = '有新接入的图片尚未分配位置，请打开故事板配置核对；不会自动加入请求。'
    if (!task.automaticPlot && !supplement.trim()) result.error = '手动模式的剧情为空，请补充后再运行。'
    return result
  } catch (cause) { return { ...result, error: cause instanceof Error ? cause.message : '故事板配置无法读取，请重新配置' } }
}

export function StoryboardTaskControls({ settings, references, prompt, disabled, candidateCount = 0, requestCandidateCount = 1, onEdit, onCompare }: { settings?: Record<string, unknown>; references: readonly UpstreamMediaReference[]; prompt: string; disabled?: boolean; candidateCount?: number; requestCandidateCount?: number; onEdit?: () => void; onCompare?: () => void }) {
  if (settings?.storyboardTask === undefined) return null
  const inspected = inspectStoryboardTaskControls(settings, references, prompt), task = inspected.task
  return <section className="storyboard-task-node nodrag nowheel" aria-label="故事板任务配置">
    <header><strong><PanelsTopLeft size={14} aria-hidden="true" />图像故事板</strong><button type="button" disabled={disabled || !onEdit} onClick={() => { if (!disabled) onEdit?.() }}><Settings2 size={13} aria-hidden="true" />配置故事板任务</button></header>
    {task && <><p>{storyboardStyleOptions.find((option) => option.value === task.style)?.label}故事板 · {task.panels} 格（{Math.sqrt(task.panels)} × {Math.sqrt(task.panels)}）</p><p>剧情模式：{task.automaticPlot ? '自动 · 显式图片分析文字节点' : '手动 · 使用已填写剧情'}</p></>}
    {inspected.sources.map((source) => <p key={source.index} className={`storyboard-task-node-source is-${source.state}`} role="status"><strong>{storyboardTaskReferenceLabel(source.index)}</strong><span>{source.label}</span></p>)}
    {inspected.error && <p className="storyboard-task-node-error" role="status">{inspected.error}</p>}
    {task && <><p className="storyboard-task-node-requests">{inspected.sources.length} 张有序输入 · 最多 {requestCandidateCount} 次图片请求{task.automaticPlot ? ' + 1 次文字请求' : ' · 0 次文字请求'}；每张候选要求一张 {task.panels} 格整图，不自动拆图。以运行预检为准，生成可能计费。</p><details className="storyboard-task-node-instructions"><summary>查看完整创作指令</summary><pre tabIndex={0} aria-label="当前节点的故事板创作指令">{inspected.prompt}</pre>{task.automaticPlot && <><strong>独立图片剧情分析指令</strong><pre tabIndex={0}>{buildStoryboardAnalysisPrompt(task, prompt)}</pre></>}<small>按保存的位置与顺序读取图片。画风与宫格通过文字要求表达；图片、文字分析、模型和来源在运行前重新核对。</small></details></>}
    {candidateCount >= 2 && onCompare && <button type="button" disabled={disabled} onClick={() => { if (!disabled) onCompare() }}><Columns2 size={13} aria-hidden="true" />对比故事板候选（{candidateCount} 张）</button>}
  </section>
}

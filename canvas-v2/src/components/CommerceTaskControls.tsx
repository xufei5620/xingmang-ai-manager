import { Package, Settings2, Columns2 } from 'lucide-react'
import { commerceTaskLabels, commerceStylePresets, commerceViews, parseCommerceTask, type CommerceTask } from '../commerce/commerce-task'
import { parseImageReferenceOrder, resolveImageReferenceSlots } from '../commerce/image-reference-order'
import type { UpstreamMediaReference } from './upstream-references'
import { inspectCommerceTaskSize } from './commerce-task-ui'
import './commerce-task.css'

export function inspectCommerceTaskControls(settings: Record<string, unknown> | undefined, references: readonly UpstreamMediaReference[], model: string, quality?: string): { task?: CommerceTask; derivedSize?: string; error: string; roles: string[] } {
  if (settings?.commerceTask === undefined) return { error: '', roles: [] }
  try {
    const task = parseCommerceTask(settings.commerceTask)
    const order = settings.imageReferenceOrder === undefined ? undefined : parseImageReferenceOrder(settings.imageReferenceOrder)
    const slots = resolveImageReferenceSlots(references.map((reference) => ({ ...reference, assetId: reference.asset?.assetId })), order)
    const source = slots.find((entry) => entry.slot.role === 'source')
    const derived = inspectCommerceTaskSize(task, source?.reference?.asset, { model, quality: quality ?? 'auto' })
    const roles = slots.map((entry) => `${entry.slot.role === 'source' ? '原始主体图' : '风格参考图'}：${entry.missing ? '绑定已失效，请重新配置' : entry.pending ? '等待上游图片' : entry.reference?.label || '图片已绑定'}`)
    return { task, derivedSize: derived.size, error: derived.error, roles }
  } catch (cause) { return { error: cause instanceof Error ? cause.message : '创作任务配置无法读取', roles: [] } }
}

export function CommerceTaskControls({ settings, references, model, quality, disabled, candidateCount = 0, onEdit, onCompare }: {
  settings?: Record<string, unknown>
  references: readonly UpstreamMediaReference[]
  model: string
  quality?: string
  disabled?: boolean
  candidateCount?: number
  onEdit?: () => void
  onCompare?: () => void
}) {
  if (settings?.commerceTask === undefined) return null
  const inspected = inspectCommerceTaskControls(settings, references, model, quality), task = inspected.task
  return <section className="commerce-task-node nodrag nowheel" aria-label="专用创作任务配置">
    <header><strong><Package size={14} />{task ? commerceTaskLabels[task.kind] : '创作任务配置待修复'}</strong><button type="button" disabled={disabled || !onEdit} onClick={onEdit}><Settings2 size={13} />配置任务</button></header>
    {task && <p>{'strength' in task ? `强度意图 ${Math.round(task.strength * 100)}%` : task.kind === 'style-preset' ? commerceStylePresets.find((entry) => entry.value === task.preset)?.label : task.kind === 'product-view' ? commerceViews.find((entry) => entry.value === task.view)?.label : '原图与风格参考图双槽'}</p>}
    {inspected.roles.map((role, index) => <small key={index}>{index + 1} · {role}</small>)}
    {task?.kind === 'material-b' && <p className="commerce-task-derived-size">原图 × {task.upscale} → {inspected.derivedSize?.replace('x', ' × ') || '尺寸待确认'}<small>输出尺寸由原图与倍率决定，通用尺寸与清晰度已锁定。</small></p>}
    {inspected.error && <p role="status" className="commerce-task-error">{inspected.error}</p>}
    {candidateCount >= 2 && onCompare && <button type="button" disabled={disabled} onClick={onCompare}><Columns2 size={13} />对比候选（{candidateCount} 张）</button>}
  </section>
}

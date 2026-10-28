import type { ImageReferenceOrder } from '../commerce/image-reference-order'
import type { ImageRequestParametersInput } from '../runtime/image-request-parameters'
import type { CanvasRunGraph } from '../host'
import { validateTextImageInputConfiguration } from '../runtime/text-image-input'

export interface StoryboardTask {
  version: 1
  kind: 'storyboard'
  automaticPlot: boolean
  style: 'white-model' | 'hand-drawn' | 'cinematic' | 'stick-figure'
  panels: 4 | 9 | 16 | 25
}
export const storyboardStyleOptions: readonly { value: StoryboardTask['style']; label: string; instruction: string }[] = [
  { value: 'white-model', label: '白膜', instruction: '以简洁白膜造型、清晰空间与光影表达镜头。' },
  { value: 'hand-drawn', label: '手绘', instruction: '以手绘线稿和明确的动作、构图表达镜头。' },
  { value: 'cinematic', label: '分镜', instruction: '以电影分镜的景别、视角和镜头调度表达叙事。' },
  { value: 'stick-figure', label: '火柴人', instruction: '以火柴人和简洁场景线条表达角色动作与镜头。' },
]
export const storyboardPanelOptions = [4, 9, 16, 25] as const
export function defaultStoryboardTask(): StoryboardTask { return { version: 1, kind: 'storyboard', automaticPlot: true, style: 'cinematic', panels: 4 } }
export function parseStoryboardTask(value: unknown): StoryboardTask {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('故事板配置格式不正确')
  const raw = value as Record<string, unknown>
  const keys = ['version', 'kind', 'automaticPlot', 'style', 'panels']
  if (Object.keys(raw).length !== keys.length || Object.keys(raw).some((key) => !keys.includes(key))) throw new Error('故事板含未知或缺少必要配置')
  if (raw.version !== 1 || raw.kind !== 'storyboard') throw new Error('故事板版本或类型不受支持')
  if (typeof raw.automaticPlot !== 'boolean' || !storyboardStyleOptions.some(({ value }) => value === raw.style) || !storyboardPanelOptions.some((value) => value === raw.panels)) throw new Error('故事板剧情开关、画风或宫格数不受支持')
  return structuredClone(raw) as unknown as StoryboardTask
}
export function parseNodeStoryboardTask(kind: string, value: unknown): StoryboardTask { if (!['image', 'image-generate', 'image-edit'].includes(kind)) throw new Error('此节点不支持故事板任务'); return parseStoryboardTask(value) }
export function storyboardTaskRoles(value: StoryboardTask, count = 1): readonly ('source' | 'reference')[] { parseStoryboardTask(value); if (!Number.isInteger(count) || count < 1 || count > 4) throw new Error('故事板需要 1–4 张有序输入图片'); return Array.from({ length: count }, (_, index) => index === 0 ? 'source' : 'reference') }
export function storyboardTaskUsesAnalysis(value: StoryboardTask): boolean { return parseStoryboardTask(value).automaticPlot }
export function buildStoryboardTaskPrompt(value: StoryboardTask, supplement: string): string {
  const task = parseStoryboardTask(value), side = Math.sqrt(task.panels)
  return ['【故事板】', '参考图片按输入编号排序：第 1 张提供主要主体与场景，其余图片按顺序提供角色、场景或叙事参考；保持主体身份与可见特征连贯。', `生成一张完整的 ${side}×${side} 故事板整图，共 ${task.panels} 个分镜面板；从左到右、从上到下连续叙事。宫格数量不是生成图片数量。`, storyboardStyleOptions.find(({ value }) => value === task.style)!.instruction, '在各面板间保持人物、物品和空间关系一致，镜头变化服务剧情。画风与宫格通过文字要求表达，不是模型原生参数。', ...(supplement.trim() ? ['剧情与补充要求：', supplement] : [])].join('\n')
}
export function buildStoryboardAnalysisPrompt(value: StoryboardTask, supplement = ''): string {
  const task = parseStoryboardTask(value)
  if (!task.automaticPlot) throw new Error('此故事板未启用自动剧情')
  return ['分析所有按输入编号排序的参考图片。第 1 张提供主要主体与场景，其余图片按顺序作为角色、场景或叙事参考。依据可见内容编写连贯、具体的中文故事板剧情，保持主体身份，不把无法观察到的细节当成事实。', `为 ${task.panels} 个连续分镜面板安排动作、景别与镜头衔接，画风为${storyboardStyleOptions.find(({ value }) => value === task.style)!.label}。只返回剧情与镜头要求，不发起图像生成。`, ...(supplement.trim() ? ['用户剧情与补充要求：', supplement] : [])].join('\n')
}
export function resolveStoryboardImageRequest(value: StoryboardTask, input: ImageRequestParametersInput): ImageRequestParametersInput { const task = parseStoryboardTask(value); if (!task.automaticPlot && !input.prompt.trim()) throw new Error('关闭自动剧情后，请填写明确的故事剧情'); return { ...input, prompt: buildStoryboardTaskPrompt(task, input.prompt) } }
export function assertStoryboardTaskConfiguration(task: StoryboardTask | undefined, order: ImageReferenceOrder | undefined, commerceTask?: unknown, interiorTask?: unknown, exteriorTask?: unknown): void {
  if (task === undefined) return
  const value = parseStoryboardTask(task)
  if (commerceTask !== undefined || interiorTask !== undefined || exteriorTask !== undefined) throw new Error('故事板与商品、室内、室外创作不能同时配置在同一节点')
  const roles = storyboardTaskRoles(value, order?.slots.length ?? 0)
  if (!order || order.slots.some((slot, index) => slot.role !== roles[index])) throw new Error('故事板需要按顺序明确绑定主体图和参考图')
}
/** Automatic plot creation must be visible, and bind the exact ordered image occurrences. */
export function assertStoryboardAnalysisConfiguration(node: CanvasRunGraph['nodes'][number], edges: readonly CanvasRunGraph['edges'][number][], nodes: ReadonlyMap<string, CanvasRunGraph['nodes'][number]>): void {
  const task = node.data.storyboardTask
  if (!task || !task.automaticPlot) return
  const text = edges.filter((edge) => edge.target === node.id && edge.targetHandle === 'in:text')
  const analysis = text.length === 1 ? nodes.get(text[0].source) : undefined
  if (!analysis || text[0].sourceHandle !== 'out:text' || analysis.kind !== 'text-generate' || analysis.disabled || analysis.data.textWebSearch || analysis.data.prompt !== buildStoryboardAnalysisPrompt(task, node.data.prompt)) throw new Error('自动剧情需要唯一、可用且与当前剧情一致的显式图片分析节点，请重新配置故事板')
  const count = node.data.imageReferenceOrder?.slots.length ?? 0
  validateTextImageInputConfiguration(analysis.data.model, count)
  const allowed = new Set(analysis.data.imageReferenceOrder?.slots.flatMap((slot) => 'edgeId' in slot ? [slot.edgeId] : []) ?? [])
  if (edges.some((edge) => edge.target === analysis.id && (edge.targetHandle !== 'in:images' || !allowed.has(edge.id)))) throw new Error('自动剧情分析存在未分配的图片或额外文字输入，请重新配置')
  function identities(target: CanvasRunGraph['nodes'][number]): string {
    const order = target.data.imageReferenceOrder
    const roles = storyboardTaskRoles(task!, count)
    if (!order || order.slots.length !== count || order.slots.some((slot, index) => slot.role !== roles[index])) throw new Error('自动剧情图片顺序尚未绑定，请重新配置')
    return JSON.stringify(order.slots.map((slot) => { const edge = 'edgeId' in slot ? edges.find((edge) => edge.id === slot.edgeId && edge.target === target.id && edge.targetHandle === 'in:images') : undefined; if (!edge || !['out:image', 'out:images'].includes(edge.sourceHandle) || !('outputIndex' in slot)) throw new Error('自动剧情输入图片已失联'); return [slot.role, edge.source, edge.sourceHandle, slot.outputIndex] }))
  }
  if (identities(node) !== identities(analysis)) throw new Error('自动剧情仍绑定另一组图片或顺序，请重新配置；不会使用旧图分析')
}

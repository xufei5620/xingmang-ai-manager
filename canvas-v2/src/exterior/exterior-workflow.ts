import { createEmptyWorkflow, type WorkflowFile } from '../model'
import { buildCommerceWorkflow, type CommerceWorkflowAsset } from '../commerce/commerce-workflow'
import { defaultCommerceTask } from '../commerce/commerce-task'
import { validateTextImageInputConfiguration } from '../runtime/text-image-input'
import { buildExteriorAnalysisPrompt, buildExteriorTaskPrompt, resolveExteriorImageRequest, exteriorTaskLabels, exteriorTaskRoles, exteriorTaskUsesAnalysis, parseExteriorTask, type ExteriorTask } from './exterior-task'
import type { ImageCandidateCount } from '../runtime/image-candidate-count'
import { mediaAssetNodeDimensions } from '../library/media-assets'
import { canvasNodeDisplayGeometry } from '../domain/node-display-geometry'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import { findAvailableCanvasPosition } from '../editor/node-placement'

export interface ExteriorWorkflowBuildInput {
  name?: string; task: ExteriorTask; source: CommerceWorkflowAsset; reference?: CommerceWorkflowAsset
  prompt: string; model: string; group?: string; size?: string; quality?: string; imageResolution?: '1K' | '2K' | '4K'; candidateCount: ImageCandidateCount
  analysis?: { model: string; group?: string; prompt?: string }; createId: () => string
}
/** Ordinary visible graph nodes preserve the existing request ledger and undo model. */
export function buildExteriorWorkflow(input: ExteriorWorkflowBuildInput): WorkflowFile {
  const task = parseExteriorTask(input.task), roles = exteriorTaskRoles(task), automatic = exteriorTaskUsesAnalysis(task)
  resolveExteriorImageRequest(task, { model: input.model, prompt: input.prompt })
  if ((roles.length === 2) !== Boolean(input.reference)) throw new Error('请按室外任务绑定唯一原图与需要的参考图')
  if (automatic !== Boolean(input.analysis)) throw new Error('自动提示必须明确配置可见的图片分析节点与文字模型')
  if (input.analysis) validateTextImageInputConfiguration(input.analysis.model, 2)
  let workflow = buildCommerceWorkflow({ ...input, tasks: [defaultCommerceTask(roles.length === 2 ? 'style-reference' : 'material-a')], analysis: input.analysis ? { ...input.analysis, prompt: buildExteriorAnalysisPrompt(task) } : undefined })
  workflow.name = input.name || exteriorTaskLabels[task.kind]
  workflow.nodes = workflow.nodes.map((node) => {
    if (node.data.settings?.commerceTask !== undefined) {
      const settings = { ...node.data.settings }; delete settings.commerceTask
      return { ...node, kind: 'image-generate', data: { ...node.data, settings: { ...settings, title: exteriorTaskLabels[task.kind], exteriorTask: task } } }
    }
    if (node.kind === 'text-generate') node.data.settings = { ...node.data.settings, title: '室外参考图分析' }
    if (node.kind === 'gallery') node.data.settings = { ...node.data.settings, title: '室外创作候选' }
    return node
  })
  // Source aspect ratios can be tall. Lay out each new node against its actual
  // display geometry; creation must not hide a second input behind the first.
  const placed: WorkflowFile['nodes'] = []
  for (const node of workflow.nodes) {
    const geometry = canvasNodeDisplayGeometry(node), fallback = builtinNodeRegistry.require(node.kind).dimensions
    const dimensions = node.kind === 'image-input' && node.data.result ? mediaAssetNodeDimensions(node.data.result) : { width: geometry.width ?? fallback.width, height: geometry.height ?? fallback.height }
    const obstacles = placed.map((entry) => { const size = canvasNodeDisplayGeometry(entry), fallback = builtinNodeRegistry.require(entry.kind).dimensions; return { ...entry, type: entry.kind, width: size.width ?? fallback.width, height: size.height ?? fallback.height } })
    node.position = findAvailableCanvasPosition(obstacles, { x: node.position.x + dimensions.width / 2, y: node.position.y + dimensions.height / 2 }, dimensions)
    node.width = dimensions.width
    if (node.kind === 'image-input') node.height = dimensions.height
    placed.push(node)
  }
  return { ...createEmptyWorkflow(workflow.name), ...workflow, nodes: placed }
}

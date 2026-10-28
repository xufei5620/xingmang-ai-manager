import { buildExteriorWorkflow } from '../exterior/exterior-workflow'
import { defaultExteriorTask, exteriorTaskRoles, exteriorTaskUsesAnalysis, type ExteriorTaskKind } from '../exterior/exterior-task'
import type { CanvasRunGraph } from '../host'
import { parseImageReferenceOrder } from '../commerce/image-reference-order'
export function exteriorTaskWorkflowFixture(kind: ExteriorTaskKind = 'exterior-render') {
  const task = defaultExteriorTask(kind); let id = 0
  return buildExteriorWorkflow({ task, source: { assetId: 'a'.repeat(43), width: 512, height: 512 }, ...(exteriorTaskRoles(task).length === 2 ? { reference: { assetId: 'b'.repeat(43), width: 640, height: 480 } } : {}), prompt: '', model: 'gpt-image-1', group: 'provider-a', size: '1536x1024', quality: 'low', imageResolution: '1K', candidateCount: 2, ...(exteriorTaskUsesAnalysis(task) ? { analysis: { model: 'gpt-4.1', group: 'provider-a' } } : {}), createId: () => `exterior-${++id}` })
}
export function exteriorTaskRunGraphFixture(kind: ExteriorTaskKind = 'exterior-render'): CanvasRunGraph {
  return exteriorRunGraphFromWorkflow(exteriorTaskWorkflowFixture(kind))
}
export function exteriorRunGraphFromWorkflow(workflow: import('../model').WorkflowFile): CanvasRunGraph {
  return { nodes: workflow.nodes.map((node) => {
    const { settings, result, ...data } = node.data
    return { id: node.id, kind: node.kind, definitionVersion: 1, data: { ...data, adoptedAssetId: result?.assetId,
      ...(settings?.exteriorTask ? { exteriorTask: settings.exteriorTask as import('../exterior/exterior-task').ExteriorTask } : {}),
      ...(settings?.imageReferenceOrder ? { imageReferenceOrder: parseImageReferenceOrder(settings.imageReferenceOrder) } : {}) } }
  }), edges: workflow.edges }
}

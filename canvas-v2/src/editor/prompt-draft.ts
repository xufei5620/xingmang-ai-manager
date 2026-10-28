import { markNodeAndDescendantsDirty } from '../runtime/run-projection'
import { canvasNodeDocumentRecord, type CanvasDocumentController } from '../store/use-canvas-document'
import { parsePromptReferences, type PromptReference } from '../library/prompt-references'

export function applyCanvasPromptDraft(
  document: Pick<CanvasDocumentController, 'getGraphSnapshot' | 'execute' | 'setNodes'>,
  nodeId: string,
  prompt: string,
  options: { discrete?: boolean; promptReferences?: PromptReference[] } = {},
) {
  const { nodes, edges } = document.getGraphSnapshot()
  const current = nodes.find((node) => node.id === nodeId)
  if (!current) return null
  const promptReferences = parsePromptReferences(prompt, options.promptReferences ?? current.data.promptReferences)
  if (current.data.prompt === prompt && JSON.stringify(current.data.promptReferences ?? []) === JSON.stringify(promptReferences)) return null
  const updated = current.data.prompt === prompt
    ? nodes.map((node) => node.id === nodeId ? { ...node, data: { ...node.data, promptReferences } } : node)
    : markNodeAndDescendantsDirty(nodes, edges, nodeId, { prompt, promptReferences })
  // Seed history before publishing the new draft. Waiting for blur would make
  // execute() record the already-edited prompt as its own undo destination.
  document.execute({ type: 'replace-nodes', nodes: updated.map(canvasNodeDocumentRecord), ...(options.discrete ? {} : { mergeKey: `data:${nodeId}` }) })
  // Keep the live editor objects through React's batched commit: converting
  // them back from document records while typing can disturb selection/caret.
  document.setNodes(updated)
  return { nodes: updated, edges }
}

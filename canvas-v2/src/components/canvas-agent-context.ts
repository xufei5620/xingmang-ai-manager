import type { CanvasAgentImageReference } from '../lib/canvas-agent-contract'
import type { CanvasAgentContextNode, CanvasAgentDraft } from './canvas-agent-panel-state'
import { canvasAgentNodeImageUnavailableReason, resolveCanvasAgentNodeImageAssetId } from '../lib/canvas-agent-image-context'
import { nodeOutputKind, type WorkflowNode } from '../model'

export const maximumAgentContextImages = 4
const identifier = /^[A-Za-z0-9_-]{1,128}$/
const assetIdentifier = /^[A-Za-z0-9_-]{43}$/
const slotIdentifier = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function agentImageReferenceKey(image: CanvasAgentImageReference): string { return 'nodeId' in image ? image.nodeId : `library:${image.slotId}` }
export function agentImageFailureKey(image: CanvasAgentImageReference): string { return `${agentImageReferenceKey(image)}:${image.assetId}` }

export function buildCanvasAgentContextNode(node: WorkflowNode, title: string): CanvasAgentContextNode {
  const imageNode = nodeOutputKind[node.kind] === 'image' || node.data.result?.kind === 'image'
  return { id: node.id, kind: node.kind, title, ...(imageNode ? { imageAssetId: resolveCanvasAgentNodeImageAssetId(node), imageUnavailableReason: canvasAgentNodeImageUnavailableReason(node) } : {}) }
}

/** Browser drafts contain only stable identities, never resolved asset URLs. */
export function parseAgentDraftImages(value: unknown, selectedNodeIds: readonly string[]): CanvasAgentImageReference[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('图片引用格式已变化，请移除图片后重新选择')
  if (value.length > maximumAgentContextImages) throw new Error('最多附加 4 张图片，请先移除部分图片')
  const keys = new Set<string>()
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('图片引用格式已变化，请重新选择')
    const raw = entry as Record<string, unknown>
    if (raw.source === 'library') {
      if (Object.keys(raw).some((key) => !['source', 'slotId', 'assetId'].includes(key)) || typeof raw.slotId !== 'string' || !slotIdentifier.test(raw.slotId)
        || typeof raw.assetId !== 'string' || !assetIdentifier.test(raw.assetId) || keys.has(`library:${raw.slotId}`)) throw new Error('素材库图片引用已损坏，请移除后重新选择')
      keys.add(`library:${raw.slotId}`)
      return { source: 'library' as const, slotId: raw.slotId, assetId: raw.assetId }
    }
    if (Object.keys(raw).some((key) => !['nodeId', 'assetId'].includes(key)) || typeof raw.nodeId !== 'string' || !identifier.test(raw.nodeId)
      || typeof raw.assetId !== 'string' || !assetIdentifier.test(raw.assetId) || keys.has(raw.nodeId) || !selectedNodeIds.includes(raw.nodeId)) throw new Error('图片引用与上下文不一致，请移除图片后重新选择')
    keys.add(raw.nodeId)
    return { nodeId: raw.nodeId, assetId: raw.assetId }
  })
}

export function agentImageReferenceIssue(reference: CanvasAgentImageReference, nodes: readonly CanvasAgentContextNode[]): string | undefined {
  if (!('nodeId' in reference)) return undefined
  const node = nodes.find((entry) => entry.id === reference.nodeId)
  if (!node) return '原节点已删除，请移除这张图片'
  if (node.imageUnavailableReason) return node.imageUnavailableReason
  if (!node.imageAssetId) return '节点已没有可用图片，请移除后重新选择'
  if (node.imageAssetId !== reference.assetId) return '当前图片已更换，请移除旧引用并重新选择'
}

export function validateAgentDraftImages(draft: Pick<CanvasAgentDraft, 'selectedNodeIds' | 'imageReferences' | 'imageReferenceError'>, nodes: readonly CanvasAgentContextNode[]): void {
  if (draft.imageReferenceError) throw new Error(draft.imageReferenceError)
  const images = parseAgentDraftImages(draft.imageReferences, draft.selectedNodeIds)
  for (const image of images) {
    const issue = agentImageReferenceIssue(image, nodes)
    if (issue) throw new Error(issue)
  }
}

export function addAgentContext(draft: CanvasAgentDraft, nodeIds: readonly string[], images: readonly CanvasAgentImageReference[] = []): Partial<CanvasAgentDraft> {
  const selectedNodeIds = [...new Set([...draft.selectedNodeIds, ...nodeIds, ...images.flatMap((image) => 'nodeId' in image ? [image.nodeId] : [])])]
  if (selectedNodeIds.length > 40) throw new Error('最多选择 40 个上下文节点，请先移除部分节点')
  // Choosing the same node again is explicit consent to its NEW current image.
  const byNode = new Map((draft.imageReferences ?? []).map((image) => [agentImageReferenceKey(image), image]))
  for (const image of images) byNode.set(agentImageReferenceKey(image), { ...image })
  const imageReferences = parseAgentDraftImages([...byNode.values()], selectedNodeIds)
  return { selectedNodeIds, imageReferences, ...(images.length ? { imageReferenceError: undefined } : {}) }
}

export function addAgentLibraryImage(draft: CanvasAgentDraft, assetId: string, createId = () => crypto.randomUUID()): Partial<CanvasAgentDraft> {
  if (!assetIdentifier.test(assetId)) throw new Error('这张图片身份无法确认，请重新选择')
  if (draft.imageReferences?.some((image) => image.assetId === assetId)) return {}
  return addAgentContext(draft, [], [{ source: 'library', slotId: createId(), assetId }])
}

export function moveAgentImage(images: readonly CanvasAgentImageReference[], key: string, direction: -1 | 1): CanvasAgentImageReference[] {
  const result = images.map((image) => ({ ...image })), index = result.findIndex((image) => agentImageReferenceKey(image) === key), target = index + direction
  if (index < 0 || target < 0 || target >= result.length) return result
  const original = result[index]
  result[index] = result[target]; result[target] = original
  return result
}

export interface AgentMentionQuery { start: number; end: number; query: string }
export function agentMentionQuery(text: string, start: number, end = start): AgentMentionQuery | null {
  if (start !== end || start < 0 || start > text.length) return null
  const match = /(?:^|\s)@([^\s@]{0,80})$/.exec(text.slice(0, start))
  return match ? { start: start - match[1].length - 1, end: start, query: match[1] } : null
}
export function consumeAgentMention(text: string, mention: AgentMentionQuery | null): { text: string; cursor: number } {
  if (!mention || text.slice(mention.start, mention.end) !== `@${mention.query}`) return { text, cursor: text.length }
  return { text: text.slice(0, mention.start) + text.slice(mention.end), cursor: mention.start }
}

/** Fits reviewed nodes inside the visible flow area, excluding an overlay panel. */
export function agentPlanFocusViewport(bounds: { x: number; y: number; width: number; height: number }, surface: { left: number; right: number; width: number; height: number }, panel?: { left: number; right: number }): { x: number; y: number; zoom: number } | null {
  const width = panel && panel.left < surface.right && panel.right > surface.left ? Math.max(0, panel.left - surface.left) : surface.width
  if (width < 240 || surface.height < 120) return null
  const zoom = Math.max(0.1, Math.min(1, (width - 64) / Math.max(1, bounds.width), (surface.height - 100) / Math.max(1, bounds.height)))
  return { x: width / 2 - (bounds.x + bounds.width / 2) * zoom, y: surface.height / 2 - (bounds.y + bounds.height / 2) * zoom, zoom }
}

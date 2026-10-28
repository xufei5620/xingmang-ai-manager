import { describe, expect, it } from 'vitest'
import type { WorkflowNode } from '../model'
import { addAgentContext, agentImageReferenceIssue, agentMentionQuery, agentPlanFocusViewport, buildCanvasAgentContextNode, consumeAgentMention, parseAgentDraftImages, validateAgentDraftImages } from './canvas-agent-context'
import type { CanvasAgentDraft } from './canvas-agent-panel-state'

const assetA = 'a'.repeat(43), assetB = 'b'.repeat(43)
const draft: CanvasAgentDraft = { text: '为产品设计场景', model: 'gpt-4.1-mini', selectedNodeIds: [] }
function node(patch: Partial<WorkflowNode['data']> = {}, kind: WorkflowNode['kind'] = 'image-input'): WorkflowNode {
  return { id: 'image-a', kind, position: { x: 0, y: 0 }, data: { prompt: '', model: '', status: 'succeeded', result: { kind: 'image', assetId: assetA }, ...patch } }
}
describe('Agent explicit image context', () => {
  it('maps only the current adopted image and never expands candidate pools or preview selections', () => {
    const value = node({ candidateAssetIds: [assetA, assetB], selectedCandidateId: 'preview-b', candidates: [{ candidateId: 'preview-b', attemptId: 'a', createdAt: '', asset: { kind: 'image', assetId: assetB } }] }, 'image-generate')
    expect(buildCanvasAgentContextNode(value, '候选图')).toEqual({ id: 'image-a', kind: 'image-generate', title: '候选图', imageAssetId: assetA, imageUnavailableReason: undefined })
    expect(buildCanvasAgentContextNode(node({}, 'gallery'), '当前展示图').imageAssetId).toBe(assetA)
  })
  it.each([{ dirty: true }, { status: 'queued' as const }, { status: 'running' as const }, { result: undefined }])('does not offer stale or pending images: %j', (data) => {
    const item = buildCanvasAgentContextNode(node(data), '产品图')
    expect(item.imageAssetId).toBeUndefined(); expect(item.imageUnavailableReason).toBeTruthy()
  })
  it('keeps text-only nodes out of the image picker while allowing read-only locked images', () => {
    const text = node({ result: undefined }, 'prompt')
    expect(buildCanvasAgentContextNode(text, '文案')).not.toHaveProperty('imageUnavailableReason')
    expect(buildCanvasAgentContextNode({ ...node(), locked: true }, '锁定素材').imageAssetId).toBe(assetA)
  })
  it('requires an explicit image choice while automatically including its textual node context', () => {
    expect(addAgentContext(draft, ['image-a']).imageReferences).toEqual([])
    const next = { ...draft, ...addAgentContext(draft, [], [{ nodeId: 'image-a', assetId: assetA }]) }
    expect(next.selectedNodeIds).toEqual(['image-a']); expect(next.imageReferences).toEqual([{ nodeId: 'image-a', assetId: assetA }])
    expect(addAgentContext(next, [], [{ nodeId: 'image-a', assetId: assetB }]).imageReferences).toEqual([{ nodeId: 'image-a', assetId: assetB }])
  })
  it('rejects overflow atomically instead of silently dropping the fifth image or forty-first node', () => {
    const images = Array.from({ length: 5 }, (_, i) => ({ nodeId: `n${i}`, assetId: assetA }))
    expect(() => addAgentContext(draft, [], images)).toThrow()
    expect(() => addAgentContext({ ...draft, selectedNodeIds: Array.from({ length: 40 }, (_, i) => `n${i}`) }, ['extra'])).toThrow('40')
    expect(draft.selectedNodeIds).toEqual([])
  })
  it.each([[{ nodeId: 'image-a', assetId: 'https://evil.test/image' }], [{ nodeId: 'missing', assetId: assetA }], [{ nodeId: 'image-a', assetId: assetA, url: '/secret' }], [{ nodeId: 'image-a', assetId: assetA }, { nodeId: 'image-a', assetId: assetB }]].map((images) => [images]))('rejects malformed or unrelated persisted references: %j', (images) => {
    expect(() => parseAgentDraftImages(images, ['image-a'])).toThrow()
  })
  it('keeps a selected snapshot unchanged and blocks changed deleted or stale nodes', () => {
    const selected = { ...draft, selectedNodeIds: ['image-a'], imageReferences: [{ nodeId: 'image-a', assetId: assetA }] }
    const current = buildCanvasAgentContextNode(node(), '商品')
    expect(() => validateAgentDraftImages(selected, [current])).not.toThrow()
    expect(agentImageReferenceIssue(selected.imageReferences[0], [{ ...current, imageAssetId: assetB }])).toContain('已更换')
    expect(() => validateAgentDraftImages(selected, [])).toThrow('已删除')
    expect(() => validateAgentDraftImages(selected, [buildCanvasAgentContextNode(node({ dirty: true }), '商品')])).toThrow('待更新')
    expect(selected.imageReferences[0].assetId).toBe(assetA)
  })
})

describe('Agent mention trigger and plain prompt text', () => {
  it('recognizes a collapsed whitespace-delimited mention without treating email addresses as references', () => {
    expect(agentMentionQuery('请参考 @商', 6)).toEqual({ start: 4, end: 6, query: '商' })
    expect(agentMentionQuery('@', 1)).toEqual({ start: 0, end: 1, query: '' })
    expect(agentMentionQuery('a@b.com', 7)).toBeNull()
    expect(agentMentionQuery('@商品', 1, 3)).toBeNull()
    expect(agentMentionQuery('@商品 已结束', 7)).toBeNull()
  })
  it('consumes only the active trigger and preserves all surrounding prose without internal IDs', () => {
    const text = '请参考 @商 设计海报'
    expect(consumeAgentMention(text, agentMentionQuery(text, 6))).toEqual({ text: '请参考  设计海报', cursor: 4 })
    expect(consumeAgentMention('已经改动', { start: 0, end: 2, query: '商' })).toEqual({ text: '已经改动', cursor: 4 })
  })
})

describe('Agent plan viewport', () => {
  it('fits every proposal node within the canvas left of the overlapping Agent panel', () => {
    const bounds = { x: 1000, y: 300, width: 700, height: 400 }, surface = { left: 48, right: 1280, width: 1232, height: 650 }, panel = { left: 900, right: 1280 }
    const viewport = agentPlanFocusViewport(bounds, surface, panel)!
    expect(bounds.x * viewport.zoom + viewport.x).toBeGreaterThanOrEqual(32)
    expect((bounds.x + bounds.width) * viewport.zoom + viewport.x).toBeLessThanOrEqual(panel.left - surface.left - 32)
    expect(bounds.y * viewport.zoom + viewport.y).toBeGreaterThanOrEqual(50)
  })
  it('requests panel collapse when narrow screens cannot display the proposed nodes alongside it', () => {
    const bounds = { x: 500, y: 500, width: 360, height: 400 }, surface = { left: 48, right: 390, width: 342, height: 700 }
    expect(agentPlanFocusViewport(bounds, surface, { left: 48, right: 390 })).toBeNull()
    expect(agentPlanFocusViewport(bounds, surface)?.zoom).toBeGreaterThan(0)
  })
})

import { describe, expect, it } from 'vitest'
import { defaultCommerceTask } from '../commerce/commerce-task'
import type { CanvasImageAssetSummary } from '../host'
import type { InteriorTaskDialogDraft } from '../components/interior-task-ui'
import type { UpstreamMediaReference } from '../components/upstream-references'
import { interiorTaskWorkflowFixture } from '../lib/interior-task.test-fixture'
import { defaultInteriorTask } from './interior-task'
import { defaultImageTransformRecipe } from '../image-tools/recipe'
import type { WorkflowNode } from '../model'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import { mediaAssetNodeDimensions } from '../library/media-assets'
import { assertInteriorNodeEditable, buildInteriorNodeEdit } from './interior-edit-application'

function asset(character = 'a'): CanvasImageAssetSummary {
  const assetId = character.repeat(43)
  return { mediaType: 'image', assetId, localUrl: `xingmang-asset://image/${assetId}`, thumbnailUrl: `xingmang-asset://image/${assetId}`, mimeType: 'image/png', fileName: 'original.png', displayName: '本人原图', width: 512, height: 512, createdAt: '2026-10-16T00:00:00.000Z' }
}
function input() {
  let sequence = 0
  const workflow = interiorTaskWorkflowFixture()
  const node = workflow.nodes[1]
  node.kind = 'image-edit'
  node.data.status = 'succeeded'
  node.data.result = { kind: 'image', assetId: 'c'.repeat(43), localUrl: `xingmang-asset://image/${'c'.repeat(43)}` }
  node.data.candidateAssetIds = ['c'.repeat(43), 'd'.repeat(43)]
  node.data.adoptedCandidateId = 'old-choice'
  const draft: InteriorTaskDialogDraft = { mode: 'edit', task: { ...defaultInteriorTask(), addDecor: true }, source: { binding: { kind: 'existing', edgeId: 'room-input', outputIndex: 0 } }, prompt: '新的补充', model: 'gpt-image-1', size: '1024x1024', quality: 'low', imageResolution: '1K', imageCandidateCount: 2 }
  const currentReferences: UpstreamMediaReference[] = [{ edgeId: 'room-input', outputIndex: 0, sourceNodeId: 'room-source', targetHandle: 'in:images', kind: 'image', status: 'ready', label: '房间', mention: '@房间', relationLabel: '图像输入', asset: { kind: 'image', assetId: asset().assetId, localUrl: asset().localUrl } }]
  return { workflow, nodeId: node.id, draft, currentReferences, assets: [asset('b')], createId: () => `replacement-${++sequence}` }
}

function worldRectangle(node: WorkflowNode, nodes: readonly WorkflowNode[]) {
  const position = { ...node.position }
  let parent = nodes.find((entry) => entry.id === node.parentId)
  while (parent) { position.x += parent.position.x; position.y += parent.position.y; parent = nodes.find((entry) => entry.id === parent!.parentId) }
  const media = node.data.result && ['image-input', 'image-edit', 'image-generate'].includes(node.kind) ? mediaAssetNodeDimensions(node.data.result, node.data.size) : undefined
  const fallback = builtinNodeRegistry.require(node.kind).dimensions
  return { ...position, width: media?.width ?? node.width ?? fallback.width, height: media?.height ?? node.height ?? fallback.height }
}

function rectanglesOverlap(first: ReturnType<typeof worldRectangle>, second: ReturnType<typeof worldRectangle>): boolean {
  return first.x < second.x + second.width + 28 && first.x + first.width + 28 > second.x
    && first.y < second.y + second.height + 28 && first.y + first.height + 28 > second.y
}

describe('interior node edit transaction', () => {
  it.each([null, false, {}, { ...defaultInteriorTask(), version: 2 }, { ...defaultInteriorTask(), filter: 'future' }])('rejects malformed original task metadata rather than overwriting it: %j', (task) => {
    const value = input(); value.workflow.nodes[1].data.settings!.interiorTask = task
    const before = structuredClone(value.workflow)
    expect(() => assertInteriorNodeEditable(value.workflow.nodes, value.nodeId)).toThrow()
    expect(() => buildInteriorNodeEdit(value)).toThrow()
    expect(value.workflow).toEqual(before)
  })
  it('rejects mixed tasks and original multi-source configuration instead of silently repairing it', () => {
    const mixed = input(); mixed.workflow.nodes[1].data.settings!.commerceTask = defaultCommerceTask('material-a')
    expect(() => buildInteriorNodeEdit(mixed)).toThrow()
    const multiple = input(); multiple.workflow.nodes[1].data.settings!.imageReferenceOrder = { version: 1, slots: [{ role: 'source', edgeId: 'room-input', outputIndex: 0 }, { role: 'reference', missing: true }] }
    expect(() => buildInteriorNodeEdit(multiple)).toThrow('唯一原图')
  })
  it('preserves existing candidates, adopted result, unrelated nodes and source connection when changing only parameters', () => {
    const value = input(), before = structuredClone(value.workflow)
    const updated = buildInteriorNodeEdit(value)
    expect(value.workflow).toEqual(before)
    expect(updated.nodes).toHaveLength(before.nodes.length); expect(updated.edges).toEqual(before.edges)
    expect(updated.nodes[0]).toEqual(before.nodes[0]); expect(updated.nodes[2]).toEqual(before.nodes[2])
    expect(updated.nodes[1].data).toMatchObject({ prompt: '新的补充', imageCandidateCount: 2, result: before.nodes[1].data.result, candidateAssetIds: before.nodes[1].data.candidateAssetIds, adoptedCandidateId: 'old-choice', status: 'succeeded' })
    expect(updated.nodes[1].data.settings!.interiorTask).toEqual(value.draft.task)
    value.draft.task.addPeople = true
    expect(updated.nodes[1].data.settings!.interiorTask).not.toEqual(value.draft.task)
  })
  it('forks only a replacement input while preserving a shared source and sibling task', () => {
    const value = input()
    value.workflow.nodes.push({ ...structuredClone(value.workflow.nodes[1]), id: 'sibling' })
    value.workflow.edges.push({ ...value.workflow.edges[0], id: 'sibling-input', target: 'sibling' })
    value.draft.source.binding = { kind: 'asset', assetId: asset('b').assetId }
    const before = structuredClone(value.workflow), result = buildInteriorNodeEdit(value)
    expect(value.workflow).toEqual(before)
    expect(result.nodes.find((node) => node.id === 'room-source')).toEqual(before.nodes[0])
    expect(result.nodes.find((node) => node.id === 'sibling')).toEqual(before.nodes[3])
    expect(result.edges.find((edge) => edge.id === 'sibling-input')).toEqual(before.edges[2])
    expect(result.nodes.find((node) => node.id === 'replacement-1')?.data.result?.assetId).toBe(asset('b').assetId)
    expect(result.edges.some((edge) => edge.id === 'room-input')).toBe(false)
    expect(result.nodes[1].data.result).toEqual(before.nodes[1].data.result)
  })
  it.each([[512, 512], [1920, 1080], [512, 2048]])('keeps a %sx%s replacement visibly separate from the original source without moving existing nodes', (width, height) => {
    const value = input(); value.assets[0].width = width; value.assets[0].height = height
    value.workflow.nodes[0].position = { x: 80, y: 80 }; value.workflow.nodes[1].position = { x: 440, y: 80 }
    value.draft.source.binding = { kind: 'asset', assetId: asset('b').assetId }
    const before = structuredClone(value.workflow), result = buildInteriorNodeEdit(value)
    const replacement = result.nodes.find((node) => node.id === 'replacement-1')!
    const rectangle = worldRectangle(replacement, result.nodes)
    expect(rectanglesOverlap(rectangle, worldRectangle(before.nodes[0], before.nodes))).toBe(false)
    for (const node of before.nodes) {
      expect(rectanglesOverlap(rectangle, worldRectangle(node, before.nodes))).toBe(false)
      expect(result.nodes.find((entry) => entry.id === node.id)?.position).toEqual(node.position)
    }
    expect(replacement).toMatchObject({ width: mediaAssetNodeDimensions(value.assets[0]).width, height: mediaAssetNodeDimensions(value.assets[0]).height })
    expect(replacement.parentId).toBeUndefined()
    expect(result.nodes[0]).toEqual(before.nodes[0]); expect(result.nodes[1].data.result).toEqual(before.nodes[1].data.result)
    expect(value.workflow).toEqual(before)
  })
  it('preserves world placement through nested groups and rejects locked, disabled, missing or cyclic ancestors', () => {
    const value = input(); value.workflow.nodes[1].parentId = 'inner'
    const group = { kind: 'group' as const, data: { prompt: '', model: '', status: 'idle' as const }, position: { x: 100, y: 200 }, width: 100, height: 100 }
    value.workflow.nodes.push({ ...group, id: 'outer' }, { ...group, id: 'inner', parentId: 'outer' })
    value.workflow.nodes.push({ ...group, id: 'obstacle-group', position: { x: 1000, y: -1000 } }, { id: 'outside-child', kind: 'image-input', parentId: 'obstacle-group', position: { x: -820, y: 1400 }, locked: true, data: { prompt: '', model: '', status: 'succeeded', result: { kind: 'image', assetId: 'e'.repeat(43), width: 512, height: 512 } } })
    value.draft.source.binding = { kind: 'asset', assetId: asset('b').assetId }
    const before = structuredClone(value.workflow), updated = buildInteriorNodeEdit(value)
    const replacement = updated.nodes.find((node) => node.id === 'replacement-1')!
    const rectangle = worldRectangle(replacement, updated.nodes)
    expect(worldRectangle(before.nodes[6], before.nodes)).toMatchObject({ x: 180, y: 400, width: 280, height: 280 })
    expect(rectanglesOverlap(rectangle, worldRectangle(before.nodes[6], before.nodes))).toBe(false)
    for (const node of before.nodes) {
      expect(rectanglesOverlap(rectangle, worldRectangle(node, before.nodes))).toBe(false)
      expect(updated.nodes.find((entry) => entry.id === node.id)?.position).toEqual(node.position)
    }
    expect(replacement).toMatchObject({ width: 280, height: 280 }); expect(replacement.parentId).toBeUndefined()
    expect([rectangle.x, rectangle.y, rectangle.width, rectangle.height].every(Number.isFinite)).toBe(true)
    expect(value.workflow).toEqual(before)
    for (const key of ['locked', 'disabled'] as const) { value.workflow.nodes[3][key] = true; expect(() => buildInteriorNodeEdit(value)).toThrow('上级分组'); delete value.workflow.nodes[3][key] }
    value.workflow.nodes[3].parentId = 'inner'; expect(() => buildInteriorNodeEdit(value)).toThrow('层级')
    delete value.workflow.nodes[3].parentId; value.workflow.nodes[1].parentId = 'missing'; expect(() => buildInteriorNodeEdit(value)).toThrow('上级分组')
  })
  it.each(['missing-parent', 'cycle', 'duplicate-id', 'nonfinite-position'])('rejects an invalid unrelated placement obstacle atomically: %s', (mode) => {
    const value = input(); value.draft.source.binding = { kind: 'asset', assetId: asset('b').assetId }
    const obstacle: WorkflowNode = { id: 'obstacle', kind: 'group', position: { x: 1000, y: 1000 }, data: { prompt: '', model: '', status: 'idle' } }
    if (mode === 'missing-parent') obstacle.parentId = 'absent'
    if (mode === 'cycle') obstacle.parentId = obstacle.id
    if (mode === 'duplicate-id') obstacle.id = value.nodeId
    if (mode === 'nonfinite-position') obstacle.position.x = Number.NaN
    value.workflow.nodes.push(obstacle)
    const before = structuredClone(value.workflow)
    expect(() => buildInteriorNodeEdit(value)).toThrow()
    expect(value.workflow).toEqual(before)
  })
  it.each(['wrong-node', 'waiting', 'wrong-kind', 'single-index', 'missing-edge'])('rejects changed or unready stable input identities: %s', (mode) => {
    const value = input()
    if (mode === 'wrong-node') value.currentReferences[0].sourceNodeId = 'some-other-node'
    if (mode === 'waiting') value.currentReferences[0].status = 'waiting'
    if (mode === 'wrong-kind') value.currentReferences[0].kind = 'video'
    if (mode === 'single-index') { value.draft.source.binding = { kind: 'existing', edgeId: 'room-input', outputIndex: 1 }; value.currentReferences[0].outputIndex = 1 }
    if (mode === 'missing-edge') value.workflow.edges.shift()
    expect(() => buildInteriorNodeEdit(value)).toThrow()
  })
  it('always rejects a wrong mask binding and preserves a valid same-source mask byte for byte', () => {
    const value = input(), mask = { version: 1, sourceAssetId: asset('b').assetId, width: 512, height: 512, strokes: [{ tool: 'brush', size: .1, points: [{ x: .5, y: .5 }] }] }
    value.workflow.nodes[1].data.settings!.imageEditMask = mask
    expect(() => buildInteriorNodeEdit(value)).toThrow('蒙版')
    mask.sourceAssetId = asset().assetId
    expect(buildInteriorNodeEdit(value).nodes[1].data.settings!.imageEditMask).toEqual(mask)
    value.draft.source.binding = { kind: 'asset', assetId: asset('b').assetId }
    expect(() => buildInteriorNodeEdit(value)).toThrow('蒙版')
  })
  it('preserves an exact grid output index and rejects unknown or out-of-range batches', () => {
    const value = input()
    value.workflow.nodes[0].kind = 'image-grid-split'
    value.workflow.nodes[0].data.settings = { imageTransform: { ...defaultImageTransformRecipe('grid-split'), rows: 2, columns: 2 } }
    value.workflow.edges[0].sourceHandle = 'out:images'
    value.draft.source.binding = { kind: 'existing', edgeId: 'room-input', outputIndex: 3 }; value.currentReferences[0].outputIndex = 3
    expect(buildInteriorNodeEdit(value).nodes[1].data.settings!.imageReferenceOrder).toEqual({ version: 1, slots: [{ role: 'source', edgeId: 'room-input', outputIndex: 3 }] })
    value.draft.source.binding.outputIndex = 4; value.currentReferences[0].outputIndex = 4
    expect(() => buildInteriorNodeEdit(value)).toThrow('批次')
    value.draft.source.binding.outputIndex = 0; value.currentReferences[0].outputIndex = 0; value.workflow.nodes[0].kind = 'gallery'
    expect(() => buildInteriorNodeEdit(value)).toThrow('批次')
  })
  it('does not silently remove an unassigned new input when preserving the current source', () => {
    const value = input(); value.workflow.edges.push({ ...value.workflow.edges[0], id: 'unexpected-extra' })
    const before = structuredClone(value.workflow)
    expect(() => buildInteriorNodeEdit(value)).toThrow('尚未分配角色')
    expect(value.workflow).toEqual(before)
  })
  it('does not create or silently retarget an existing visual analysis when the source changes', () => {
    const value = input()
    value.workflow.nodes.push({ id: 'analysis', kind: 'text-generate', position: { x: 0, y: 500 }, data: { prompt: '看图分析', model: 'vision', status: 'succeeded', outputText: '旧图分析' } })
    value.workflow.edges.push({ id: 'analysis-image', source: 'room-source', target: 'analysis', sourceHandle: 'out:image', targetHandle: 'in:images' }, { id: 'analysis-text', source: 'analysis', target: value.nodeId, sourceHandle: 'out:text', targetHandle: 'in:text' })
    expect(buildInteriorNodeEdit(value).nodes.find((node) => node.id === 'analysis')).toEqual(value.workflow.nodes[3])
    value.draft.source.binding = { kind: 'asset', assetId: asset('b').assetId }
    expect(() => buildInteriorNodeEdit(value)).toThrow('图片分析')
    expect(value.workflow.nodes).toHaveLength(4)
  })
  it('rejects unavailable owned replacement assets without mutating the original workflow', () => {
    const value = input(); value.draft.source.binding = { kind: 'asset', assetId: asset('b').assetId }
    const before = structuredClone(value.workflow)
    value.assets[0].deletedAt = '2026-10-16T01:00:00.000Z'
    expect(() => buildInteriorNodeEdit(value)).toThrow('新图片')
    expect(value.workflow).toEqual(before)
  })
})

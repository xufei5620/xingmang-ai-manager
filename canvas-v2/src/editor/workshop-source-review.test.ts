import { describe, expect, it } from 'vitest'
import { createEmptyWorkflow, type WorkflowFile, type WorkflowNode } from '../model'
import { buildWorkshopSelection, buildWorkshopSelectionForSourceReview } from './workshop-graph'
import { sanitizeWorkshopWorkflow } from '../lib/workshop-sanitizer'

function node(id: string, kind: WorkflowNode['kind'], parentId?: string): WorkflowNode {
  return { id, kind, position: { x: 200, y: 300 }, ...(parentId ? { parentId } : {}), data: { prompt: '', model: 'kept-model', status: 'idle', ...(kind === 'image-generate' ? { group: 'private-provider' } : {}) } }
}
function fixture(): WorkflowFile {
  return { ...createEmptyWorkflow('Original'), mediaGroups: { image: 'global-provider', imageModel: 'global-model' }, nodes: [node('group', 'group'), node('nested', 'group', 'group'), node('image', 'image-generate', 'nested'), node('outside', 'prompt')], edges: [{ id: 'outside-image', source: 'outside', sourceHandle: 'out:text', target: 'image', targetHandle: 'in:text' }] }
}

describe('explicit workshop source review selection', () => {
  it('captures recursive raw pins without changing the original graph or the existing selection behavior', () => {
    const source = fixture(), before = structuredClone(source)
    const review = buildWorkshopSelectionForSourceReview(source, ['group'])
    expect(review).toEqual(buildWorkshopSelection(source, ['group']))
    expect(review.nodes.map((entry) => entry.id)).toEqual(['group', 'nested', 'image'])
    expect(review.nodes[2].data).toMatchObject({ group: 'private-provider', model: 'kept-model' })
    expect(review.edges).toEqual([])
    expect(source).toEqual(before)
    review.nodes[2].data.model = 'edited-review'; expect(source.nodes[2].data.model).toBe('kept-model')
    expect(() => sanitizeWorkshopWorkflow(review, 'group', 'Must still refuse raw pins')).toThrow('固定了本人模型来源')
  })
  it('refuses malformed raw source presence instead of hiding it during review capture', () => {
    const source = fixture(); Reflect.set(source.nodes[2].data, 'group', null)
    const before = structuredClone(source)
    expect(() => buildWorkshopSelectionForSourceReview(source, ['image'])).toThrow('固定模型来源格式无效')
    expect(source).toEqual(before)
    expect(() => buildWorkshopSelectionForSourceReview(source, ['group-missing'])).toThrow('内容节点')
  })
})

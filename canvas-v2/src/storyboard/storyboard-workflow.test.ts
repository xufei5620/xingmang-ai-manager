import { describe, expect, it } from 'vitest'
import { parseImageReferenceOrder } from '../commerce/image-reference-order'
import { canvasNodeDisplayGeometry } from '../domain/node-display-geometry'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import { buildStoryboardWorkflow, type StoryboardWorkflowBuildInput } from './storyboard-workflow'
import { buildStoryboardAnalysisPrompt, defaultStoryboardTask, storyboardPanelOptions, storyboardStyleOptions } from './storyboard-task'

function input(): StoryboardWorkflowBuildInput {
  let id = 0
  return { task: defaultStoryboardTask(), sources: [{ assetId: 'a'.repeat(43), width: 512, height: 2048 }], prompt: '主角从车站走向海边', model: 'gpt-image-1', group: 'images', size: '1536x1024', quality: 'low', imageResolution: '1K', candidateCount: 2, analysis: { model: 'gpt-4.1-mini', group: 'vision' }, createId: () => `story-${++id}` }
}
describe('ordinary storyboard workflow construction', () => {
  it.each(storyboardStyleOptions.flatMap(({ value }) => storyboardPanelOptions.map((panels) => [value, panels] as const)))('keeps %s with %i panels in one image node', (style, panels) => {
    const value = input(); value.task = { ...value.task, style, panels }
    const before = structuredClone({ ...value, createId: undefined }), workflow = buildStoryboardWorkflow(value)
    expect({ ...value, createId: undefined }).toEqual(before)
    expect(workflow.nodes.map((node) => node.kind)).toEqual(['image-input', 'text-generate', 'image-generate', 'gallery'])
    const target = workflow.nodes.find((node) => node.kind === 'image-generate')!, analysis = workflow.nodes.find((node) => node.kind === 'text-generate')!
    expect(target.data).toMatchObject({ prompt: value.prompt, imageCandidateCount: 2, settings: { storyboardTask: value.task } })
    expect(analysis.data).toMatchObject({ model: 'gpt-4.1-mini', group: 'vision', prompt: buildStoryboardAnalysisPrompt(value.task, value.prompt) })
    expect(workflow.edges.filter((edge) => edge.target === target.id && edge.targetHandle === 'in:text')).toEqual([{ id: expect.any(String), source: analysis.id, target: target.id, sourceHandle: 'out:text', targetHandle: 'in:text' }])
  })
  it.each([1, 2, 3, 4])('binds all %i ordered inputs to both visible analysis and generation', (count) => {
    const value = input(); value.sources = Array.from({ length: count }, (_, index) => ({ assetId: String.fromCharCode(97 + index).repeat(43), width: 512, height: 2048 }))
    const workflow = buildStoryboardWorkflow(value), targets = workflow.nodes.filter((node) => ['text-generate', 'image-generate'].includes(node.kind))
    const origins = targets.map((target) => parseImageReferenceOrder(target.data.settings?.imageReferenceOrder).slots.map((slot) => {
      if (!('edgeId' in slot)) throw new Error('Missing bound fixture')
      return [slot.role, workflow.edges.find((edge) => edge.id === slot.edgeId)!.source, slot.outputIndex]
    }))
    expect(origins[0]).toEqual(origins[1])
    expect(origins[0].map((slot) => slot[0])).toEqual(Array.from({ length: count }, (_, index) => index === 0 ? 'source' : 'reference'))
    for (const [index, node] of workflow.nodes.entries()) for (const other of workflow.nodes.slice(index + 1)) {
      const left = canvasNodeDisplayGeometry(node), right = canvasNodeDisplayGeometry(other), a = builtinNodeRegistry.require(node.kind).dimensions, b = builtinNodeRegistry.require(other.kind).dimensions
      expect(node.position.x < other.position.x + (right.width ?? b.width) + 28 && node.position.x + (left.width ?? a.width) + 28 > other.position.x && node.position.y < other.position.y + (right.height ?? b.height) + 28 && node.position.y + (left.height ?? a.height) + 28 > other.position.y).toBe(false)
    }
  })
  it('creates manual plots without any hidden text generation', () => {
    const value = input(); value.task.automaticPlot = false; delete value.analysis; value.candidateCount = 4
    const workflow = buildStoryboardWorkflow(value)
    expect(workflow.nodes.map((node) => node.kind)).toEqual(['image-input', 'image-generate', 'gallery'])
    expect(workflow.edges).toHaveLength(2)
    expect(workflow.nodes.find((node) => node.kind === 'image-generate')?.data.imageCandidateCount).toBe(4)
  })
  it.each(['empty', 'five', 'duplicate', 'invalid-asset', 'dimensions', 'missing-analysis', 'unknown-vision', 'manual-empty', 'manual-analysis', 'missing-count', 'id-collision', 'bad-id'])('rejects %s before returning a graph', (mode) => {
    const value = input()
    if (mode === 'empty') value.sources = []
    if (mode === 'five') value.sources = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ assetId: id.repeat(43) }))
    if (mode === 'duplicate') value.sources = [value.sources[0], value.sources[0]]
    if (mode === 'invalid-asset') value.sources = [{ assetId: '../asset' }]
    if (mode === 'dimensions') value.sources = [{ ...value.sources[0], height: Number.NaN }]
    if (mode === 'missing-analysis') delete value.analysis
    if (mode === 'unknown-vision') value.analysis = { model: 'unverified-vision-alias' }
    if (mode === 'manual-empty') { value.task.automaticPlot = false; delete value.analysis; value.prompt = '  ' }
    if (mode === 'manual-analysis') value.task.automaticPlot = false
    if (mode === 'missing-count') delete (value as Partial<StoryboardWorkflowBuildInput>).candidateCount
    if (mode === 'id-collision') value.createId = () => 'same'
    if (mode === 'bad-id') value.createId = () => 'bad\nidentifier'
    expect(() => buildStoryboardWorkflow(value)).toThrow()
  })
})

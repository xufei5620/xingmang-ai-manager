import { describe, expect, it } from 'vitest'
import { storyboardTaskEditSignature, storyboardTaskInitialSourceCurrent, storyboardTaskSourceSignature, toCanvasNode, toCanvasRunGraph, toWorkflowNode } from '../App'
import { buildCanvasUpstreamReferences } from '../components/upstream-references'
import { parseImageReferenceOrder } from '../commerce/image-reference-order'
import { buildStoryboardWorkflow } from './storyboard-workflow'
import { buildStoryboardAnalysisPrompt, defaultStoryboardTask, storyboardStyleOptions } from './storyboard-task'

function workflow(count = 3, automaticPlot = true) {
  let id = 0
  return buildStoryboardWorkflow({ task: { ...defaultStoryboardTask(), automaticPlot, panels: 25 }, sources: Array.from({ length: count }, (_, index) => ({ assetId: String.fromCharCode(97 + index).repeat(43), width: 1200, height: 800 })), prompt: '从车站出发并在海边结束', model: 'gpt-image-1', size: '1536x1024', imageResolution: '1K', quality: 'high', candidateCount: 2, ...(automaticPlot ? { analysis: { model: 'gpt-4.1', group: 'vision-source' } } : {}), createId: () => `project-${++id}` })
}
describe('actual App storyboard projections and frozen edit identity', () => {
  it.each([1, 2, 3, 4])('retains all %i repeated-reference roles and exact occurrences in both App projections', (count) => {
    const original = workflow(count), nodes = original.nodes.map(toCanvasNode), target = original.nodes.find((node) => node.data.settings?.storyboardTask)!
    const projected = toCanvasRunGraph(nodes, original.edges, { image: 'images', video: '', text: 'vision-source' }), image = projected.nodes.find((node) => node.id === target.id)!, analysis = projected.nodes.find((node) => node.kind === 'text-generate')!
    expect(image.data).toMatchObject({ storyboardTask: target.data.settings?.storyboardTask, imageReferenceOrder: target.data.settings?.imageReferenceOrder, prompt: target.data.prompt, group: 'images', model: 'gpt-image-1', imageCandidateCount: 2 })
    expect(image.data).not.toHaveProperty('commerceTask'); expect(image.data).not.toHaveProperty('interiorTask'); expect(image.data).not.toHaveProperty('exteriorTask')
    expect(analysis.data).toMatchObject({ prompt: buildStoryboardAnalysisPrompt(defaultStoryboardTaskWithPanels(), target.data.prompt), model: 'gpt-4.1', group: 'vision-source' })
    expect(parseImageReferenceOrder(image.data.imageReferenceOrder).slots.map((slot) => slot.role)).toEqual(['source', ...Array(count - 1).fill('reference')])
    expect(nodes.map(toWorkflowNode).find((node) => node.id === target.id)?.data).toMatchObject(target.data)
    expect(projected.nodes.filter((node) => node.kind === 'image-generate')).toHaveLength(1)
  })
  it.each(storyboardStyleOptions.map(({ value }) => value))('preserves explicit %s style and manual absence of analysis', (style) => {
    const original = workflow(2, false), target = original.nodes.find((node) => node.data.settings?.storyboardTask)!
    target.data.settings!.storyboardTask = { ...defaultStoryboardTask(), automaticPlot: false, style, panels: 16 }
    const projected = toCanvasRunGraph(original.nodes.map(toCanvasNode), original.edges, { image: 'images', video: '' })
    expect(projected.nodes.find((node) => node.id === target.id)?.data.storyboardTask).toEqual(target.data.settings!.storyboardTask)
    expect(projected.nodes.some((node) => node.kind === 'text-generate')).toBe(false)
  })
  it.each([null, { ...defaultStoryboardTask(), version: 2 }, { ...defaultStoryboardTask(), panels: 6 }, { ...defaultStoryboardTask(), style: 'unknown' }])('rejects malformed task metadata without replacing it by a default: %j', (value) => {
    const original = workflow(), nodes = original.nodes.map(toCanvasNode), target = nodes.find((node) => node.data.settings?.storyboardTask)!
    target.data.settings!.storyboardTask = value
    expect(() => toCanvasRunGraph(nodes, original.edges, { image: '', video: '' })).toThrow()
    expect(target.data.settings!.storyboardTask).toEqual(value)
  })
  it.each(['analysis-prose', 'analysis-model', 'analysis-order', 'source-result', 'image-edge', 'text-edge', 'target-parent', 'source-parent', 'resolved-reference'])('invalidates the edit signature for a %s change', (cause) => {
    const original = workflow(), target = original.nodes.find((node) => node.data.settings?.storyboardTask)!, analysis = original.nodes.find((node) => node.kind === 'text-generate')!, source = original.nodes.find((node) => node.kind === 'image-input')!
    const before = storyboardTaskEditSignature(original.nodes, original.edges, target.id, [])
    if (cause === 'analysis-prose') analysis.data.prompt += '过期'
    if (cause === 'analysis-model') analysis.data.model = 'gpt-4.1-mini'
    if (cause === 'analysis-order') { const order = parseImageReferenceOrder(analysis.data.settings?.imageReferenceOrder); [order.slots[1], order.slots[2]] = [order.slots[2], order.slots[1]]; analysis.data.settings!.imageReferenceOrder = order }
    if (cause === 'source-result') source.data.result!.assetId = 'z'.repeat(43)
    if (cause === 'image-edge') original.edges.find((edge) => edge.target === target.id && edge.targetHandle === 'in:images')!.sourceHandle = 'out:images'
    if (cause === 'text-edge') original.edges.find((edge) => edge.target === target.id && edge.targetHandle === 'in:text')!.sourceHandle = 'out:image'
    if (cause === 'target-parent') target.parentId = 'new-parent'
    if (cause === 'source-parent') source.parentId = 'new-parent'
    const references = cause === 'resolved-reference' ? [{ edgeId: original.edges[0].id, outputIndex: 0, status: 'missing' }] : []
    expect(storyboardTaskEditSignature(original.nodes, original.edges, target.id, references)).not.toBe(before)
  })
  it('captures locked image and analysis ancestors but ignores unrelated edits and array ordering', () => {
    const original = workflow(), target = original.nodes.find((node) => node.data.settings?.storyboardTask)!, source = original.nodes.find((node) => node.kind === 'image-input')!, analysis = original.nodes.find((node) => node.kind === 'text-generate')!
    original.nodes.push({ id: 'parent', kind: 'group', position: { x: 100, y: 200 }, data: { prompt: '', model: '', status: 'idle' } })
    source.parentId = 'parent'; analysis.parentId = 'parent'
    const before = storyboardTaskEditSignature(original.nodes, original.edges, target.id, [])
    expect(storyboardTaskEditSignature([...original.nodes].reverse(), [...original.edges].reverse(), target.id, [])).toBe(before)
    original.nodes.find((node) => node.kind === 'gallery')!.position.x += 200
    expect(storyboardTaskEditSignature(original.nodes, original.edges, target.id, [])).toBe(before)
    original.nodes.find((node) => node.id === 'parent')!.locked = true
    expect(storyboardTaskEditSignature(original.nodes, original.edges, target.id, [])).not.toBe(before)
  })
  it('uses edge plus outputIndex identity when a batch contains repeated reference roles', () => {
    const original = workflow(4), nodes = original.nodes.map(toCanvasNode), target = nodes.find((node) => node.data.settings?.storyboardTask)!
    const references = buildCanvasUpstreamReferences(nodes, original.edges, []).get(target.id) ?? []
    expect(references.map((entry) => entry.asset?.assetId)).toEqual(['a', 'b', 'c', 'd'].map((value) => value.repeat(43)))
    const before = storyboardTaskEditSignature(nodes.map(toWorkflowNode), original.edges, target.id, references)
    expect(storyboardTaskEditSignature(nodes.map(toWorkflowNode), original.edges, target.id, references.map((entry, index) => index === 2 ? { ...entry, outputIndex: 1 } : entry))).not.toBe(before)
  })
  it('freezes the selected source metadata while allowing only first unresolved defaults to settle', () => {
    const groups = [{ name: 'image-source', description: '图片', ratio: 1, revision: 1 }], current = storyboardTaskSourceSignature(groups, 'image-source')
    expect(storyboardTaskInitialSourceCurrent(storyboardTaskSourceSignature([]), current, 'image-source')).toBe(true)
    expect(storyboardTaskInitialSourceCurrent(storyboardTaskSourceSignature([], 'image-source'), current, 'image-source')).toBe(true)
    expect(storyboardTaskInitialSourceCurrent(storyboardTaskSourceSignature([], 'different'), current, 'image-source')).toBe(false)
    expect(storyboardTaskInitialSourceCurrent(current, storyboardTaskSourceSignature([{ ...groups[0], revision: 2 }], 'image-source'), 'image-source')).toBe(false)
    expect(storyboardTaskSourceSignature([...groups, { name: 'unrelated', description: '', ratio: 1 }], 'image-source')).toBe(current)
  })
})
function defaultStoryboardTaskWithPanels() { return { ...defaultStoryboardTask(), panels: 25 as const } }

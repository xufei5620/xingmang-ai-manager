import { describe, expect, it } from 'vitest'
import { exteriorTaskEditSignature, exteriorTaskInitialSourceCurrent, exteriorTaskSourceSignature, toCanvasNode, toCanvasRunGraph, toWorkflowNode } from '../App'
import { buildExteriorWorkflow } from './exterior-workflow'
import { defaultExteriorTask, exteriorTaskKinds, exteriorTaskUsesAnalysis, type ExteriorTaskKind } from './exterior-task'

function workflow(kind: ExteriorTaskKind = 'landscape-redesign') {
  const task = defaultExteriorTask(kind)
  let sequence = 0
  return buildExteriorWorkflow({ task, source: { assetId: 'a'.repeat(43), width: 1200, height: 800 },
    ...(!['exterior-render', 'exterior-redraw'].includes(kind) ? { reference: { assetId: 'b'.repeat(43), width: 800, height: 1200 } } : {}),
    prompt: '保留原有开口和入口', model: 'gpt-image-1', size: '1536x1024', imageResolution: '1K', quality: 'high', candidateCount: 2,
    ...(exteriorTaskUsesAnalysis(task) ? { analysis: { model: 'gpt-4.1', group: 'vision-source' } } : {}), createId: () => `exterior-${++sequence}` })
}

describe('exterior App projection and edit session', () => {
  it.each(exteriorTaskKinds)('preserves the structured %s task and exact reference occurrences in both projections', (kind) => {
    const original = workflow(kind), nodes = original.nodes.map(toCanvasNode)
    const data = toCanvasRunGraph(nodes, original.edges, { image: 'image-source', video: '', text: 'vision-source' }).nodes.find((node) => node.data.exteriorTask)!.data
    const target = original.nodes.find((node) => node.data.settings?.exteriorTask)!
    expect(data).toMatchObject({ exteriorTask: target.data.settings?.exteriorTask, imageReferenceOrder: target.data.settings?.imageReferenceOrder, prompt: '保留原有开口和入口', group: 'image-source', model: 'gpt-image-1', size: '1536x1024', imageResolution: '1K', quality: 'high', imageCandidateCount: 2 })
    expect(nodes.map(toWorkflowNode).find((node) => node.id === target.id)?.data).toMatchObject(target.data)
    expect(data).not.toHaveProperty('commerceTask')
    expect(data).not.toHaveProperty('interiorTask')
    const analyses = toCanvasRunGraph(nodes, original.edges, { image: 'image-source', video: '', text: 'vision-source' }).nodes.filter((node) => node.kind === 'text-generate')
    expect(analyses).toHaveLength(exteriorTaskUsesAnalysis(defaultExteriorTask(kind)) ? 1 : 0)
    if (analyses.length) expect(analyses[0].data).toMatchObject({ model: 'gpt-4.1', group: 'vision-source', imageReferenceOrder: { version: 1, slots: [{ role: 'source' }, { role: 'reference' }] } })
  })

  it.each([null, { ...defaultExteriorTask('exterior-render'), version: 2 }, { ...defaultExteriorTask('exterior-render'), weather: 'unknown' }, { ...defaultExteriorTask('exterior-render'), nativeDenoise: .5 }])('rejects unsupported metadata without stripping the original field: %j', (value) => {
    const original = workflow(), nodes = original.nodes.map(toCanvasNode)
    const target = nodes.find((node) => node.data.settings?.exteriorTask)!
    target.data.settings = { ...target.data.settings, exteriorTask: value }
    expect(() => toCanvasRunGraph(nodes, original.edges, { image: '', video: '' })).toThrow()
    expect(target.data.settings.exteriorTask).toEqual(value)
  })

  it('detects an analysis prompt or image result change even when the target node is unchanged', () => {
    const original = workflow(), target = original.nodes.find((node) => node.data.settings?.exteriorTask)!
    const before = exteriorTaskEditSignature(original.nodes, original.edges, target.id, [])
    const analysisChanged = structuredClone(original)
    analysisChanged.nodes.find((node) => node.kind === 'text-generate')!.data.prompt += '外来指令'
    expect(exteriorTaskEditSignature(analysisChanged.nodes, analysisChanged.edges, target.id, [])).not.toBe(before)
    const imageChanged = structuredClone(original)
    imageChanged.nodes.find((node) => node.kind === 'image-input')!.data.result!.assetId = 'c'.repeat(43)
    expect(exteriorTaskEditSignature(imageChanged.nodes, imageChanged.edges, target.id, [])).not.toBe(before)
    expect(exteriorTaskEditSignature(original.nodes, original.edges, target.id, [{ status: 'missing' }])).not.toBe(before)
  })

  it('detects locked ancestor groups but tolerates unrelated node edits and array reordering', () => {
    const original = workflow(), target = original.nodes.find((node) => node.data.settings?.exteriorTask)!
    target.parentId = 'group'
    original.nodes.push({ id: 'group', kind: 'group', position: { x: 100, y: 100 }, data: { prompt: '', model: '', status: 'idle' } })
    const before = exteriorTaskEditSignature(original.nodes, original.edges, target.id, [])
    expect(exteriorTaskEditSignature([...original.nodes].reverse(), [...original.edges].reverse(), target.id, [])).toBe(before)
    original.nodes.find((node) => node.kind === 'gallery')!.position.x += 100
    expect(exteriorTaskEditSignature(original.nodes, original.edges, target.id, [])).toBe(before)
    original.nodes.find((node) => node.id === 'group')!.locked = true
    expect(exteriorTaskEditSignature(original.nodes, original.edges, target.id, [])).not.toBe(before)
  })

  it('distinguishes source edits under the same name and changes of the selected source', () => {
    const groups = [{ name: 'source-a', description: '图片', ratio: 1, revision: 1 }]
    const before = exteriorTaskSourceSignature(groups, 'source-a')
    expect(exteriorTaskSourceSignature([{ ...groups[0], revision: 2 }], 'source-a')).not.toBe(before)
    expect(exteriorTaskSourceSignature(groups, 'source-b')).not.toBe(before)
    expect(exteriorTaskSourceSignature([], 'source-a')).not.toBe(before)
    expect(exteriorTaskSourceSignature([...groups, { name: 'unrelated', description: '', ratio: 1 }], 'source-a')).toBe(before)
  })

  it('allows the first unresolved default source while rejecting an already selected source change', () => {
    const groups = [{ name: 'source-a', description: '图片', ratio: 1, revision: 1 }], current = exteriorTaskSourceSignature(groups, 'source-a')
    expect(exteriorTaskInitialSourceCurrent(exteriorTaskSourceSignature([]), current, 'source-a')).toBe(true)
    expect(exteriorTaskInitialSourceCurrent(exteriorTaskSourceSignature([], 'source-a'), current, 'source-a')).toBe(true)
    expect(exteriorTaskInitialSourceCurrent(exteriorTaskSourceSignature([], 'source-b'), current, 'source-a')).toBe(false)
    expect(exteriorTaskInitialSourceCurrent(exteriorTaskSourceSignature([{ ...groups[0], revision: 0 }], 'source-a'), current, 'source-a')).toBe(false)
    expect(exteriorTaskInitialSourceCurrent(current, current, 'source-a')).toBe(true)
  })
})

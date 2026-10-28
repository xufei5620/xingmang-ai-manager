import { defaultStoryboardTask } from '../storyboard/storyboard-task'
import { defaultImageTransformRecipe } from '../image-tools/recipe'
import { describe, expect, it } from 'vitest'
import type { CanvasRunGraph, CanvasRunRecord } from '../host'
import type { WorkflowNode } from '../model'
import { matchingCanvasRunNodeIds } from './run-input-matching'
import { projectRunRecordToNodes, selectNodeCandidate, type ProjectableCanvasNode } from './run-projection'

function graph(): CanvasRunGraph {
  return {
    nodes: [
      { id: 'prompt', kind: 'prompt', definitionVersion: 1, data: { prompt: 'prompt A', model: '' } },
      { id: 'image', kind: 'image-generate', definitionVersion: 1, data: { prompt: '', model: 'gpt-image-1', group: 'source' } },
      { id: 'gallery', kind: 'gallery', definitionVersion: 1, data: { prompt: '', model: '' } },
      { id: 'independent', kind: 'text-generate', definitionVersion: 1, data: { prompt: 'summarize', model: 'gpt-4o-mini', group: 'source' } },
    ],
    edges: [
      { id: 'e1', source: 'prompt', sourceHandle: 'out:text', target: 'image', targetHandle: 'in:text' },
      { id: 'e2', source: 'image', sourceHandle: 'out:image', target: 'gallery', targetHandle: 'in:image' },
    ],
  }
}

function completedRun(): CanvasRunRecord {
  const at = '2026-10-10T12:00:00.000Z'
  return {
    version: 1, projectId: 'project', runId: 'run', userId: 1, ownerId: 1, graphRevision: 'revision', scope: { kind: 'all' }, status: 'succeeded', createdAt: at, startedAt: at, events: [],
    nodes: [{ nodeId: 'image', kind: 'image-generate', state: 'succeeded', attempts: [{ attemptId: 'attempt', fingerprint: 'fingerprint', state: 'succeeded', startedAt: at, completedAt: at, durationMs: 10, cached: false, candidates: [{ candidateId: 'candidate', attemptId: 'attempt', createdAt: at, asset: { kind: 'image', assetId: 'new-image', localUrl: '/api/assets/new-image/content' } }] }] }],
  }
}

describe('run input matching', () => {
  it.each(['stroke', 'source', 'dimensions', 'remove'] as const)('isolates late masked results after a %s change while retaining the previous saved output', (change) => {
    const submitted = graph()
    submitted.nodes[1].kind = 'image-edit'
    submitted.nodes[1].data.imageEditMask = { version: 1, sourceAssetId: 'a'.repeat(43), width: 8, height: 8, strokes: [{ tool: 'brush', size: 0.5, points: [{ x: 0.5, y: 0.5 }] }] }
    const current = structuredClone(submitted)
    const mask = current.nodes[1].data.imageEditMask!
    if (change === 'stroke') mask.strokes[0].points[0].x = 0.75
    if (change === 'source') mask.sourceAssetId = 'b'.repeat(43)
    if (change === 'dimensions') mask.width = 9
    if (change === 'remove') delete current.nodes[1].data.imageEditMask
    const run = completedRun(); run.nodes[0].kind = 'image-edit'
    const matching = matchingCanvasRunNodeIds(submitted, current, run)
    expect([...matching]).toEqual(['prompt', 'independent'])
    const nodes: WorkflowNode[] = [{ id: 'image', kind: 'image-edit', position: { x: 0, y: 0 }, data: { prompt: '', model: 'gpt-image-1', status: 'running', dirty: true, settings: { imageEditMask: current.nodes[1].data.imageEditMask }, result: { kind: 'image', assetId: 'existing-image' } } }]
    const projected = projectRunRecordToNodes(nodes, run, current.edges, matching)
    expect(projected[0].data).toMatchObject({ dirty: true, result: { assetId: 'existing-image' }, settings: { imageEditMask: current.nodes[1].data.imageEditMask } })
    expect(projected[0].data.candidates?.[0].asset.assetId).toBe('new-image')
    expect(projected[0].data.adoptedCandidateId).toBeUndefined()
    expect([...matchingCanvasRunNodeIds(submitted, structuredClone(submitted), run)]).toEqual(['prompt', 'image', 'gallery', 'independent'])
  })

  it('keeps identical configurations eligible after a reload', () => {
    expect([...matchingCanvasRunNodeIds(graph(), structuredClone(graph()))]).toEqual(['prompt', 'image', 'gallery', 'independent'])
  })

  it('invalidates edited prompts and their descendants while preserving independent branches', () => {
    const current = graph()
    current.nodes[0].data.prompt = 'prompt B'
    expect([...matchingCanvasRunNodeIds(graph(), current)]).toEqual(['independent'])
  })

  it('invalidates changed provider or model selections and downstream results', () => {
    const current = graph()
    current.nodes[1].data.group = 'other-source'
    current.nodes[1].data.model = 'other-model'
    expect([...matchingCanvasRunNodeIds(graph(), current)]).toEqual(['prompt', 'independent'])
  })

  it('invalidates rewired inputs but ignores edge identifier changes', () => {
    const renamed = graph()
    renamed.edges[0].id = 'new-edge-id'
    expect(matchingCanvasRunNodeIds(graph(), renamed).has('image')).toBe(true)
    renamed.edges[0].source = 'independent'
    expect(matchingCanvasRunNodeIds(graph(), renamed).has('image')).toBe(false)
    expect(matchingCanvasRunNodeIds(graph(), renamed).has('gallery')).toBe(false)
  })

  it('distinguishes this run output from a manually replaced upstream asset', () => {
    const current = graph()
    current.nodes[1].data.adoptedAssetId = 'new-image'
    expect(matchingCanvasRunNodeIds(graph(), current, completedRun()).has('gallery')).toBe(true)
    current.nodes[1].data.adoptedAssetId = 'unrelated-image'
    expect(matchingCanvasRunNodeIds(graph(), current, completedRun()).has('gallery')).toBe(false)
    expect(matchingCanvasRunNodeIds(graph(), current, completedRun()).has('image')).toBe(true)
  })

  it('accepts the exact gallery output echo without accepting another candidate or an unrelated binding', () => {
    const submitted = graph()
    submitted.nodes.push({ id: 'output', kind: 'output', definitionVersion: 1, data: { prompt: '', model: '' } })
    submitted.edges.push({ id: 'e3', source: 'gallery', sourceHandle: 'out:image', target: 'output', targetHandle: 'in:image' })
    const run = completedRun()
    const gallery = structuredClone(run.nodes[0])
    gallery.nodeId = 'gallery'
    gallery.kind = 'gallery'
    gallery.attempts[0].candidates.push({ ...gallery.attempts[0].candidates[0], candidateId: 'other-candidate', asset: { kind: 'image', assetId: 'other-image', localUrl: '/api/assets/other-image/content' } })
    run.nodes.push(gallery)
    const current = structuredClone(submitted)
    current.nodes[2].data.adoptedAssetId = 'new-image'
    expect(matchingCanvasRunNodeIds(submitted, current, run).has('gallery')).toBe(true)
    expect(matchingCanvasRunNodeIds(submitted, current, run).has('output')).toBe(true)
    expect(matchingCanvasRunNodeIds(submitted, current).has('gallery')).toBe(false)
    for (const assetId of ['other-image', 'unrelated-image']) {
      current.nodes[2].data.adoptedAssetId = assetId
      expect(matchingCanvasRunNodeIds(submitted, current, run).has('gallery')).toBe(false)
      expect(matchingCanvasRunNodeIds(submitted, current, run).has('output')).toBe(false)
    }
    current.nodes[2].data.adoptedAssetId = 'new-image'
    current.nodes[2].data.prompt = 'manual change'
    expect(matchingCanvasRunNodeIds(submitted, current, run).has('gallery')).toBe(false)
  })

  it.each(['queued', 'running', 'cancelling'] as const)('preserves both clean and stale input markers during %s progress', (state) => {
    for (const dirty of [false, true]) {
      const run = completedRun()
      run.nodes[0].nodeId = 'gallery'
      run.nodes[0].kind = 'gallery'
      run.nodes[0].state = state
      run.nodes[0].attempts = []
      const nodes: ProjectableCanvasNode[] = [{ id: 'gallery', data: { prompt: '', model: '', status: 'succeeded', dirty, result: { kind: 'image', assetId: 'previous' } } }]
      expect(projectRunRecordToNodes(nodes, run)[0].data.dirty).toBe(dirty)
      run.nodes[0].state = 'failed'
      expect(projectRunRecordToNodes(nodes, run)[0].data.dirty).toBe(true)
    }
  })

  it('retains old candidates without adopting them or clearing an edited node dirty state', () => {
    const current = graph()
    current.nodes[0].data.prompt = 'prompt B'
    const nodes: WorkflowNode[] = [{ id: 'image', kind: 'image-generate', position: { x: 0, y: 0 }, data: { prompt: 'new instructions', model: 'gpt-image-1', status: 'running', dirty: true, result: { kind: 'image', assetId: 'existing-image' } } }]
    const projected = projectRunRecordToNodes(nodes, completedRun(), current.edges, matchingCanvasRunNodeIds(graph(), current, completedRun()))
    expect(projected[0].data).toMatchObject({ prompt: 'new instructions', dirty: true, status: 'succeeded', result: { assetId: 'existing-image' } })
    expect(projected[0].data.candidates?.[0].asset.assetId).toBe('new-image')
    expect(projected[0].data.adoptedCandidateId).toBeUndefined()
    expect(projected[0].data.runStage).toBeUndefined()
  })

  it('still adopts results for unchanged input chains', () => {
    const nodes: WorkflowNode[] = [{ id: 'image', kind: 'image-generate', position: { x: 0, y: 0 }, data: { prompt: '', model: 'gpt-image-1', status: 'running', dirty: true } }]
    const projected = projectRunRecordToNodes(nodes, completedRun(), graph().edges, matchingCanvasRunNodeIds(graph(), graph(), completedRun()))
    expect(projected[0].data).toMatchObject({ dirty: false, status: 'succeeded', result: { assetId: 'new-image' }, adoptedCandidateId: 'candidate' })
  })
})


describe('image transform input matching', () => {
  it('rejects late collage output and its descendants after input ordering changes', () => {
    const submitted = graph()
    submitted.nodes[1] = { id: 'image', kind: 'image-collage', definitionVersion: 1, data: { prompt: '', model: '', imageTransform: defaultImageTransformRecipe('collage'), imageCollageInputOrder: { version: 1, slots: [{ edgeId: 'e1', outputIndex: 0 }, { edgeId: 'e3', outputIndex: 0 }] } } }
    const current = structuredClone(submitted)
    expect([...matchingCanvasRunNodeIds(submitted, current)]).toEqual(['prompt', 'image', 'gallery', 'independent'])
    current.nodes[1].data.imageCollageInputOrder!.slots.reverse()
    const matching = matchingCanvasRunNodeIds(submitted, current)
    expect([...matching]).toEqual(['prompt', 'independent'])
    const run = completedRun(); run.nodes[0].kind = 'image-collage'
    const nodes: WorkflowNode[] = [{ id: 'image', kind: 'image-collage', position: { x: 0, y: 0 }, data: { prompt: '', model: '', status: 'running', dirty: true, result: { kind: 'image', assetId: 'current-order-image' } } }]
    const projected = projectRunRecordToNodes(nodes, run, current.edges, matching)
    expect(projected[0].data).toMatchObject({ dirty: true, result: { assetId: 'current-order-image' } })
  })

  it('treats recreated collage edge identities as changed when their identities control ordering', () => {
    const submitted = graph()
    submitted.nodes[1].kind = 'image-collage'
    submitted.nodes[1].data.imageTransform = defaultImageTransformRecipe('collage')
    submitted.nodes[1].data.imageCollageInputOrder = { version: 1, slots: [{ edgeId: 'e1', outputIndex: 0 }] }
    const current = structuredClone(submitted); current.edges[0].id = 'reconnected-edge'
    expect([...matchingCanvasRunNodeIds(submitted, current)]).toEqual(['prompt', 'independent'])
    delete submitted.nodes[1].data.imageCollageInputOrder; delete current.nodes[1].data.imageCollageInputOrder
    expect(matchingCanvasRunNodeIds(submitted, current).has('image')).toBe(true)
  })

  it('rejects a late result after changing the recipe and every downstream result', () => {
    const submitted = graph()
    submitted.nodes[1] = { id: 'image', kind: 'image-crop', definitionVersion: 1, data: { prompt: '', model: '', imageTransform: defaultImageTransformRecipe('crop') } }
    const current = structuredClone(submitted)
    const recipe = current.nodes[1].data.imageTransform!
    if (recipe.kind !== 'crop') throw new Error('unexpected fixture recipe')
    recipe.x = 0.25
    recipe.width = 0.75
    expect([...matchingCanvasRunNodeIds(submitted, current)]).toEqual(['prompt', 'independent'])
  })

  it('preserves indexed batch order when a selected candidate is projected first', () => {
    const run = completedRun()
    run.nodes[0].kind = 'image-grid-split'
    const selected = run.nodes[0].attempts[0].candidates[0]
    selected.outputIndex = 1
    run.nodes[0].attempts[0].candidates.push({ ...selected, candidateId: 'first', outputIndex: 0, asset: { ...selected.asset, assetId: 'first-image' } })
    const nodes: WorkflowNode[] = [{ id: 'image', kind: 'image-grid-split', position: { x: 0, y: 0 }, data: { prompt: '', model: '', status: 'running' } }]
    const projected = projectRunRecordToNodes(nodes, run)
    expect(projected[0].data.result?.assetId).toBe('new-image')
    expect(projected[0].data.candidateAssetIds).toEqual(['first-image', 'new-image'])
    expect(projected[0].data.candidates?.map((candidate) => candidate.outputIndex)).toEqual([1, 0])
  })
})


it('keeps batch consumers eligible while a transform single-image selection changes', () => {
  const submitted = graph()
  submitted.nodes[1].kind = 'image-grid-split'
  submitted.nodes[1].data.imageTransform = defaultImageTransformRecipe('grid-split')
  submitted.edges.push({ id: 'batch', source: 'image', sourceHandle: 'out:images', target: 'independent', targetHandle: 'in:images' })
  const current = structuredClone(submitted)
  current.nodes[1].data.imageOutputIndex = 1
  current.nodes[1].data.adoptedAssetId = 'second-image'
  const eligible = matchingCanvasRunNodeIds(submitted, current)
  expect(eligible.has('image')).toBe(true)
  expect(eligible.has('independent')).toBe(true)
  expect(eligible.has('gallery')).toBe(false)
})


it('does not dirty a batch consumer when changing the single selected slice', () => {
  const run = completedRun()
  run.nodes[0].kind = 'image-grid-split'
  const first = run.nodes[0].attempts[0].candidates[0]
  first.outputIndex = 0
  const second = { ...first, candidateId: 'second', outputIndex: 1, asset: { ...first.asset, assetId: 'second-image' } }
  const nodes: ProjectableCanvasNode[] = [{ id: 'image', data: { prompt: '', model: '', status: 'succeeded' as const, result: first.asset, candidates: [first, second], candidateAssetIds: [first.asset.assetId, second.asset.assetId] } }, { id: 'single', data: { prompt: '', model: '', status: 'succeeded' as const } }, { id: 'batch', data: { prompt: '', model: '', status: 'succeeded' as const } }]
  const result = selectNodeCandidate(nodes, [{ source: 'image', sourceHandle: 'out:image', target: 'single' }, { source: 'image', sourceHandle: 'out:images', target: 'batch' }], 'image', 'second')
  expect(result.find((node) => node.id === 'single')?.data.dirty).toBe(true)
  expect(result.find((node) => node.id === 'batch')?.data.dirty).not.toBe(true)
  expect(result[0].data.candidateAssetIds).toEqual([first.asset.assetId, second.asset.assetId])
})

it('keeps the displayed batch intact when a late transform result no longer matches its recipe', () => {
  const run = completedRun()
  run.nodes[0].kind = 'image-grid-split'
  run.nodes[0].attempts[0].candidates[0].outputIndex = 0
  const nodes: WorkflowNode[] = [{ id: 'image', kind: 'image-grid-split', position: { x: 0, y: 0 }, data: { prompt: '', model: '', status: 'succeeded', result: { kind: 'image', assetId: 'original' }, candidateAssetIds: ['original'] } }]
  const result = projectRunRecordToNodes(nodes, run, [], new Set())
  expect(result[0].data.candidateAssetIds).toEqual(['original'])
  expect(result[0].data.candidates).toBeUndefined()
  expect(result[0].data.dirty).toBe(true)
})


it.each(['panels', 'style', 'automaticPlot', 'remove'] as const)('does not adopt a late storyboard result after a %s change', (field) => {
  const submitted = graph(); submitted.nodes[1].data.storyboardTask = defaultStoryboardTask()
  const current = structuredClone(submitted), task = current.nodes[1].data.storyboardTask!
  if (field === 'panels') task.panels = 25
  if (field === 'style') task.style = 'stick-figure'
  if (field === 'automaticPlot') task.automaticPlot = false
  if (field === 'remove') delete current.nodes[1].data.storyboardTask
  expect([...matchingCanvasRunNodeIds(submitted, current)]).toEqual(['prompt', 'independent'])
  expect([...matchingCanvasRunNodeIds(submitted, structuredClone(submitted))]).toEqual(['prompt', 'image', 'gallery', 'independent'])
})

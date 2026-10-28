import { describe, expect, it } from 'vitest'
import { sanitizeWorkshopWorkflow } from '../lib/workshop-sanitizer'
import { buildCanvasUpstreamReferences } from '../components/upstream-references'
import { buildWorkshopSelection, instantiateWorkshopGraph } from '../editor/workshop-graph'
import { createEmptyWorkflow, parseWorkflowFile, serializeWorkflow, type WorkflowFile, type WorkflowNode } from '../model'
import { sanitizeWorkflowV2 } from '../persistence/workflow-sanitizer'
import { toPersistedWorkflowV2 } from '../persistence/workflow-schema'
import { createCanvasDocument } from '../store/canvas-state'
import { applyCanvasCommand, createCanvasHistory, undoCanvasHistory } from '../store/history'
import { canvasNodeDocumentRecord } from '../store/use-canvas-document'
import { defaultImageTransformRecipe, type ImageLayerRecipe } from './recipe'
import { layerVectorRecipeFixture } from './layer-vector.test-fixture'
import { imageCollageTemplates } from './collage-templates'

const assetA = 'a'.repeat(43), assetB = 'b'.repeat(43), assetC = 'c'.repeat(43)

function layerRecipe(): ImageLayerRecipe {
  return { kind: 'layer', outputWidth: 800, outputHeight: 600, background: 'transparent', layers: [
    { sourceIndex: 2, x: -0.1, y: 0.2, width: 0.8, height: 1.2, rotation: 25, opacity: 0.35, blend: 'multiply', visible: true },
    { sourceIndex: 0, x: 0.1, y: -0.25, width: 0.2, height: 0.3, rotation: -90, opacity: 0.8, blend: 'screen', visible: false },
    { sourceIndex: 1, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1, blend: 'source-over', visible: true },
  ] }
}

function imageNode(id: string, assetId: string): WorkflowNode {
  return { id, kind: 'image-input', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: '', model: '', status: 'succeeded', result: { kind: 'image', assetId, localUrl: `xingmang-asset://image/${assetId}`, width: 80, height: 60 } } }
}

function workflow(): WorkflowFile {
  return { ...createEmptyWorkflow('Layer roundtrip'), nodes: [imageNode('first', assetA), imageNode('second', assetB),
    { id: 'layers', kind: 'image-layer', definitionVersion: 1, position: { x: 400, y: 200 }, data: { prompt: '', model: '', status: 'idle', settings: { title: 'Layer order', imageTransform: layerRecipe() } } },
  ], edges: [
    { id: 'edge-b', source: 'second', sourceHandle: 'out:image', target: 'layers', targetHandle: 'in:images' },
    { id: 'edge-a', source: 'first', sourceHandle: 'out:image', target: 'layers', targetHandle: 'in:images' },
    { id: 'edge-b-again', source: 'second', sourceHandle: 'out:image', target: 'layers', targetHandle: 'in:images' },
  ] }
}

function restore(value: WorkflowFile): WorkflowFile {
  const restored = parseWorkflowFile(serializeWorkflow(value))
  if (!restored) throw new Error('expected persisted workflow')
  return restored
}

function references(value: WorkflowFile, nodeId = 'layers') {
  return buildCanvasUpstreamReferences(value.nodes.map((node) => ({ id: node.id, type: node.kind, data: { ...node.data } })), value.edges, []).get(nodeId)
}

describe('image tool project and workshop persistence', () => {
  it('retains cubic handles, masked gradients and independent edit history through project and workshop reuse', () => {
    const original = workflow(), recipe = layerVectorRecipeFixture()
    original.nodes[2].data.settings = { imageTransform: recipe, apiKey: 'private-key' }
    const saved = sanitizeWorkshopWorkflow(restore(restore(original)), 'group', 'Editable vector')
    let sequence = 0
    const copy = instantiateWorkshopGraph(saved, () => `vector-${++sequence}`)
    expect(restore(copy).nodes[2].data.settings?.imageTransform).toEqual(recipe)
    const content = (copy.nodes[2].data.settings!.imageTransform as ImageLayerRecipe).layers[0].content
    if (content?.kind !== 'path') throw new Error('expected cubic path')
    content.handles![0].out![0] = 1
    expect((saved.nodes[2].data.settings!.imageTransform as ImageLayerRecipe).layers[0].content).toEqual(recipe.layers[0].content)
    expect(JSON.stringify(saved)).not.toMatch(/private-key|xingmang-asset:|candidateAssetIds/)
    expect(copy.nodes[2].data.result).toBeUndefined()
  })
  it('preserves native raster selections and outlines across save, asset-free workshop copy and independent reuse', () => {
    const original = workflow(), recipe = layerRecipe()
    const selection = { kind: 'raster' as const, transform: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number], inverted: true, raster: { width: 4, height: 2, runs: [0, 2, 4, 4] }, feather: { radius: 5, space: { width: 640, height: 720 } } }
    recipe.layers = [{ ...recipe.layers[0], content: { kind: 'paint' }, mask: selection, edits: { version: 1, operations: [{ mode: 'fill', color: '#aabbcc', opacity: 0.5, selection }, { mode: 'outline', color: '#ff660080', width: 5, opacity: 0.8, position: 'outside', space: { width: 640, height: 720 }, selection }] } }]
    original.nodes[2].data.settings = { imageTransform: recipe, apiKey: 'private-key' }
    const reopened = restore(restore(original)), saved = sanitizeWorkshopWorkflow(reopened, 'group', 'Pixel selection')
    let index = 0
    const copy = instantiateWorkshopGraph(saved, () => `raster-${++index}`)
    expect(restore(copy).nodes[2].data.settings?.imageTransform).toEqual(recipe)
    const copied = copy.nodes[2].data.settings!.imageTransform as ImageLayerRecipe
    if (copied.layers[0].mask?.kind !== 'raster') throw new Error('expected raster mask')
    copied.layers[0].mask.raster.runs[0] = 1
    expect((saved.nodes[2].data.settings!.imageTransform as ImageLayerRecipe).layers[0].mask).toMatchObject({ raster: { runs: [0, 2, 4, 4] } })
    expect(JSON.stringify(saved)).not.toContain('private-key')
    expect(JSON.stringify(copy)).not.toContain('xingmang-asset://')
    expect(copy.nodes[2].data.result).toBeUndefined()
  })
  it('preserves feathered fill history and masks in asset-free workshop copies without sharing mutable state', () => {
    const original = workflow(), recipe = layerRecipe()
    const selection = { kind: 'ellipse' as const, transform: [0.5, 0, 0, 0.5, 0.25, 0.25] as [number, number, number, number, number, number], inverted: true, feather: { radius: 5, space: { width: 640, height: 720 } } }
    recipe.layers = [{ ...recipe.layers[0], content: { kind: 'paint' }, edits: { version: 1, operations: [{ mode: 'fill', color: '#a6ddc480', opacity: 0.5, selection }] }, mask: selection }]
    original.nodes[2].data.settings = { imageTransform: recipe }
    const saved = sanitizeWorkshopWorkflow(restore(original), 'group', 'Feathered fill')
    expect(saved.nodes[2].data.settings?.imageTransform).toEqual(recipe)
    let index = 0
    const copy = instantiateWorkshopGraph(saved, () => `fill-${++index}`)
    expect(restore(copy).nodes[2].data.settings?.imageTransform).toEqual(recipe)
    const copied = copy.nodes[2].data.settings!.imageTransform as ImageLayerRecipe
    copied.layers[0].mask!.feather!.radius = 20
    expect((saved.nodes[2].data.settings!.imageTransform as ImageLayerRecipe).layers[0].mask!.feather!.radius).toBe(5)
    expect(JSON.stringify(copy)).not.toContain('xingmang-asset://')
    expect(copy.nodes[2].data.result).toBeUndefined()
  })
  it('preserves ordered local paint, erase and reversible masks through project and workshop roundtrips', () => {
    const original = workflow()
    const recipe = layerRecipe()
    recipe.layers = [{ ...recipe.layers[0], content: { kind: 'paint' }, edits: { version: 1, operations: ['paint', 'erase', 'paint'].map((mode) => ({ mode: mode as 'paint' | 'erase', points: [[1000, 2000], [6000, 7000]], size: 30, hardness: 0.7, opacity: 0.5, color: '#cc0000', space: { width: 800, height: 600 }, selection: { kind: 'ellipse', transform: [1, 0, 0, 1, 0, 0], inverted: true } })) }, mask: { kind: 'rectangle', transform: [0.5, 0, 0, 1, 0.25, 0], inverted: false } }]
    original.nodes[2].data.settings = { imageTransform: recipe, apiKey: 'private-key' }
    expect(restore(restore(original)).nodes[2].data.settings?.imageTransform).toEqual(recipe)
    const saved = sanitizeWorkshopWorkflow(original, 'group', 'Editable paint')
    expect(saved.nodes[2].data.settings?.imageTransform).toEqual(recipe)
    expect(JSON.stringify(saved)).not.toContain('private-key')
    let sequence = 0
    const inserted = instantiateWorkshopGraph(saved, () => `paint-${++sequence}`)
    expect(restore(inserted).nodes[2].data.settings?.imageTransform).toEqual(recipe)
    const result = inserted.nodes[2].data.settings!.imageTransform as ImageLayerRecipe
    const resultStroke = result.layers[0].edits!.operations[0], savedStroke = (saved.nodes[2].data.settings!.imageTransform as ImageLayerRecipe).layers[0].edits!.operations[0]
    if (!('points' in resultStroke) || !('points' in savedStroke)) throw new Error('expected stroke')
    resultStroke.points[0][0] = 99
    expect(savedStroke.points[0][0]).toBe(1000)
    original.nodes[2].data.settings = { imageTransform: { ...recipe, layers: [{ ...recipe.layers[0], edits: { version: 1, operations: [{ ...recipe.layers[0].edits!.operations[0], sourceUrl: 'https://private.invalid' }] } }] } }
    expect(() => sanitizeWorkshopWorkflow(original, 'group', 'Unsafe paint')).toThrow('不支持的字段')
  })
  it('preserves every layer field and ordered duplicate input edge over repeated project saves', () => {
    const original = workflow()
    const restored = restore(restore(original))
    expect(restored.nodes.find((node) => node.id === 'layers')?.data.settings?.imageTransform).toEqual(layerRecipe())
    expect(restored.edges).toEqual(original.edges)
    expect(references(restored)?.map((entry) => [entry.edgeId, entry.asset?.assetId])).toEqual([['edge-b', assetB], ['edge-a', assetA], ['edge-b-again', assetB]])
  })

  it.each(['crop', 'collage', 'grid-split', 'tile'] as const)('roundtrips all persisted %s recipe fields', (kind) => {
    const original = workflow()
    original.edges = []
    const node = original.nodes[2]
    node.kind = `image-${kind}`
    node.data.settings = { imageTransform: defaultImageTransformRecipe(kind) }
    expect(restore(original).nodes[2].data.settings?.imageTransform).toEqual(defaultImageTransformRecipe(kind))
  })

  it('preserves every collage layout and style through project saves and asset-free workshop insertion', () => {
    for (const layout of ['grid', 'horizontal', 'vertical', 'hero-left', 'hero-top', ...imageCollageTemplates.map((template) => template.layout)] as const) {
      const original = workflow(), node = original.nodes[2]
      node.kind = 'image-collage'
      const recipe = { ...defaultImageTransformRecipe('collage'), layout, autoSize: layout === 'horizontal' || layout === 'vertical', cornerRadius: 18, borderWidth: 3, borderColor: '#ffcc00', shadow: false, watermark: { text: '原创测试', color: '#ffffff', opacity: .3, fontSize: 18 } }
      node.data.settings = { imageTransform: recipe }
      expect(restore(restore(original)).nodes[2].data.settings?.imageTransform).toEqual(recipe)
      const portable = sanitizeWorkshopWorkflow(original, 'group', 'Styled collage')
      expect(portable.nodes[2].data.settings?.imageTransform).toEqual(recipe)
      let id = 0
      const inserted = instantiateWorkshopGraph(portable, () => `new-${++id}`)
      expect(inserted.nodes[2].data.settings?.imageTransform).toEqual(recipe)
      expect(inserted.edges.map((edge) => edge.source)).toEqual(['new-2', 'new-1', 'new-2'])
      expect(inserted.nodes.every((entry) => !entry.data.result)).toBe(true)
    }
  })

  it('rejects node-kind mismatch in save, import and workshop paths', () => {
    const original = workflow()
    original.nodes[2].data.settings = { imageTransform: defaultImageTransformRecipe('crop') }
    expect(() => serializeWorkflow(original)).toThrow('节点类型不匹配')
    expect(sanitizeWorkflowV2(original)).toBeNull()
    expect(() => sanitizeWorkshopWorkflow(original, 'group', 'Invalid mismatch')).toThrow('节点类型不匹配')
  })

  it('rejects unknown recipe fields at both save and import boundaries', () => {
    const original = workflow()
    original.nodes[2].data.settings = { imageTransform: { ...layerRecipe(), endpoint: 'https://private.invalid/should-not-pass' } }
    expect(() => serializeWorkflow(original)).toThrow('不支持的字段')
    expect(sanitizeWorkflowV2(original)).toBeNull()
    expect(() => sanitizeWorkshopWorkflow(original, 'group', 'Unsafe recipe')).toThrow('不支持的字段')
  })

  it('strips sensitive generic settings without losing the strict layer recipe', () => {
    const original = workflow()
    original.nodes[2].data.settings = { imageTransform: layerRecipe(), title: 'Safe title', apiKey: 'private-key', nested: { accessToken: 'private-token', secret: 'private-secret', harmless: 'keep' } }
    const persisted = toPersistedWorkflowV2(original)
    expect(persisted.nodes[2].data.settings).toEqual({ imageTransform: layerRecipe(), title: 'Safe title', nested: { harmless: 'keep' } })
    expect(JSON.stringify(persisted)).not.toMatch(/private-key|private-token|private-secret/)
    expect(restore(original).nodes[2].data.settings?.imageTransform).toEqual(layerRecipe())
  })

  it('retains batch output order after refresh and preserves a repeated batch connection', () => {
    const original = workflow()
    original.nodes[1] = { ...original.nodes[1], kind: 'image-grid-split', data: { prompt: '', model: '', status: 'succeeded', settings: { imageTransform: defaultImageTransformRecipe('grid-split') }, candidateAssetIds: [assetC, assetA, assetB], result: { kind: 'image', assetId: assetA } } }
    original.edges = [
      { id: 'batch-1', source: 'second', sourceHandle: 'out:images', target: 'layers', targetHandle: 'in:images' },
      { id: 'single', source: 'first', sourceHandle: 'out:image', target: 'layers', targetHandle: 'in:images' },
      { id: 'batch-2', source: 'second', sourceHandle: 'out:images', target: 'layers', targetHandle: 'in:images' },
    ]
    const restored = restore(original)
    expect(restored.nodes[1].data.candidateAssetIds).toEqual([assetC, assetA, assetB])
    expect(references(restored)?.map((entry) => entry.asset?.assetId)).toEqual([assetC, assetA, assetB, assetA, assetC, assetA, assetB])
  })

  it('keeps waiting references in their edge slots instead of reordering ready sources', () => {
    const original = workflow()
    original.nodes[1].data.result = undefined
    expect(references(original)?.map((entry) => [entry.edgeId, entry.status])).toEqual([['edge-b', 'waiting'], ['edge-a', 'ready'], ['edge-b-again', 'waiting']])
  })

  it('restores every ordered grid output after deleting the node and undoing without an earlier runtime instance', () => {
    const node = canvasNodeDocumentRecord({ id: 'grid', type: 'image-grid-split', definitionVersion: 1, position: { x: 0, y: 0 }, data: {
      prompt: '', model: '', status: 'succeeded', settings: { imageTransform: defaultImageTransformRecipe('grid-split') },
      result: { kind: 'image', assetId: assetB }, candidateAssetIds: [assetC, assetA, assetB],
    } })
    const state = createCanvasHistory({ ...createCanvasDocument(), nodes: [node] })
    const deleted = applyCanvasCommand(state, { type: 'delete-elements', nodeIds: ['grid'] })
    expect(deleted.present.nodes).toHaveLength(0)
    const restored = undoCanvasHistory(deleted).present.nodes[0]
    expect(restored.data.candidateAssetIds).toEqual([assetC, assetA, assetB])
    expect(restored.data).not.toHaveProperty('status')
    expect(restored.data.settings).toEqual({ imageTransform: defaultImageTransformRecipe('grid-split') })
  })

  it('saves and inserts workshop layers without assets, output state, source settings or unknown capabilities', () => {
    const original = workflow()
    const tool = original.nodes[2]
    tool.data.status = 'succeeded'
    tool.data.group = 'private-provider'
    tool.data.result = { kind: 'image', assetId: assetC, localUrl: `xingmang-asset://image/${assetC}` }
    tool.data.candidateAssetIds = [assetC]
    tool.data.settings = { ...tool.data.settings, unknownCapability: 'drop me', authorization: 'secret-value' }
    const selection = buildWorkshopSelection(original, original.nodes.map((node) => node.id))
    const saved = sanitizeWorkshopWorkflow(selection, 'group', 'Reusable layers')
    expect(saved.nodes[2].data.settings).toEqual({ title: 'Layer order', imageTransform: layerRecipe() })
    expect(saved.nodes.every((node) => node.data.status === 'idle' && !node.data.result && !node.data.candidateAssetIds && !node.data.group)).toBe(true)
    expect(JSON.stringify(saved)).not.toMatch(/private-provider|secret-value|unknownCapability/)
    let sequence = 0
    const inserted = instantiateWorkshopGraph(saved, () => `new-${++sequence}`)
    expect(inserted.nodes[2].data.settings?.imageTransform).toEqual(layerRecipe())
    expect(inserted.edges.map((edge) => inserted.nodes.findIndex((node) => node.id === edge.source))).toEqual([1, 0, 1])
    expect(inserted.edges.map((edge) => edge.target)).toEqual(Array(3).fill(inserted.nodes[2].id))
    expect(restore(inserted).nodes[2].data.settings?.imageTransform).toEqual(layerRecipe())
    const imageTransform = inserted.nodes[2].data.settings?.imageTransform as ImageLayerRecipe
    imageTransform.layers[0].opacity = 0
    expect((saved.nodes[2].data.settings?.imageTransform as ImageLayerRecipe).layers[0].opacity).toBe(0.35)
  })
})

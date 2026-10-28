import { describe, expect, it } from 'vitest'
import { sanitizeWorkshopWorkflow } from '../lib/workshop-sanitizer'
import { instantiateWorkshopGraph } from '../editor/workshop-graph'
import { createEmptyWorkflow, parseWorkflowFile, serializeWorkflow, type WorkflowFile, type WorkflowNode } from '../model'
import { sanitizeWorkflowV2 } from '../persistence/workflow-sanitizer'
import { createCanvasDocument } from '../store/canvas-state'
import { applyCanvasCommand, createCanvasHistory, redoCanvasHistory, undoCanvasHistory } from '../store/history'
import type { EditorNodeRecord } from '../domain/node-definition'
import { defaultImageLayerTypography, imageLayerTextWarpStyles, type ImageLayerTextWarpStyle } from './layer-text-layout'
import { parseImageTransformRecipe, type ImageLayerRecipe, type ImageLayerTextContent } from './recipe'

function recipe(style?: ImageLayerTextWarpStyle): ImageLayerRecipe {
  return { kind: 'layer', outputWidth: 640, outputHeight: 480, background: 'transparent', layers: [{
    sourceIndex: 0, x: .1, y: .1, width: .8, height: .8, rotation: 15, opacity: .7, blend: 'screen', visible: true,
    content: { kind: 'text', text: '中文 👩🏽‍💻 e\u0301 office\n完整第二行', color: '#abcdef', fontSize: 36, fontFamily: 'sans-serif', fontWeight: 400, align: 'center',
      ...(style ? { typography: { ...defaultImageLayerTypography(), fontFamily: 'R43 Local Font', fontSource: 'local', fontWeight: 600, lineHeight: 1.9, letterSpacing: 15, warp: { style, bend: -65 } } } : {}) },
  }], explicitLayers: true }
}
function workflow(): WorkflowFile {
  return { ...createEmptyWorkflow('可复用文字排版'), nodes: imageLayerTextWarpStyles.map(({ id }, index): WorkflowNode => ({ id: `text-${id}`, kind: 'image-layer', definitionVersion: 1, position: { x: index * 400, y: 80 }, data: { prompt: '', model: '', status: 'succeeded', settings: { imageTransform: recipe(id), title: id, apiKey: 'synthetic-secret' }, result: { kind: 'image', assetId: 'a'.repeat(43), localUrl: `xingmang-asset://image/${'a'.repeat(43)}` }, candidateAssetIds: ['a'.repeat(43)] } })), edges: [] }
}
function restore(value: WorkflowFile): WorkflowFile {
  const parsed = parseWorkflowFile(serializeWorkflow(value))
  if (!parsed) throw new Error('expected valid complete workflow')
  return parsed
}
function textOf(node: WorkflowNode): ImageLayerTextContent {
  const parsed = parseImageTransformRecipe(node.data.settings?.imageTransform)
  if (parsed.kind !== 'layer' || parsed.layers[0].content?.kind !== 'text') throw new Error('expected text layer')
  return parsed.layers[0].content
}
function records(value: WorkflowFile): EditorNodeRecord[] {
  return value.nodes.map((node) => ({ id: node.id, type: node.kind, definitionVersion: 1, position: { ...node.position }, data: { prompt: node.data.prompt, model: node.data.model, settings: structuredClone(node.data.settings) } }))
}

describe('typography project and workshop persistence', () => {
  it('preserves all thirteen deformations and explicit local fonts through repeated save and import', () => {
    const original = workflow(), roundtrip = restore(restore(original)), sanitized = sanitizeWorkflowV2(JSON.parse(serializeWorkflow(original)))
    expect(sanitized).not.toBeNull()
    expect(roundtrip.nodes).toHaveLength(13)
    expect(sanitized?.workflow.nodes).toHaveLength(13)
    for (const [index, node] of roundtrip.nodes.entries()) {
      expect(textOf(node)).toEqual(textOf(original.nodes[index]))
      expect(textOf(sanitized!.workflow.nodes[index])).toEqual(textOf(original.nodes[index]))
      expect(textOf(node).typography).toMatchObject({ fontSource: 'local', fontFamily: 'R43 Local Font', fontWeight: 600, lineHeight: 1.9, letterSpacing: 15, warp: { style: imageLayerTextWarpStyles[index].id, bend: -65 } })
    }
    expect(JSON.stringify(roundtrip)).not.toContain('synthetic-secret')
  })
  it('keeps editable typography in asset-free templates and independently instantiated graphs', () => {
    const original = workflow(), saved = sanitizeWorkshopWorkflow(restore(original), 'group', '全部文字变形')
    let sequence = 0
    const copy = instantiateWorkshopGraph(saved, () => `new-${++sequence}`), second = instantiateWorkshopGraph(saved, () => `new-${++sequence}`)
    expect(copy.nodes.every((node, index) => node.id !== saved.nodes[index].id && node.id !== second.nodes[index].id)).toBe(true)
    for (const [index, node] of restore(copy).nodes.entries()) expect(textOf(node)).toEqual(textOf(original.nodes[index]))
    expect(JSON.stringify(saved)).not.toMatch(/synthetic-secret|xingmang-asset:|candidateAssetIds|localUrl|taskId/)
    expect(copy.nodes.every((node) => !node.data.result && !node.data.candidateAssetIds)).toBe(true)
    const copiedRecipe = copy.nodes[0].data.settings!.imageTransform as ImageLayerRecipe
    if (copiedRecipe.layers[0].content?.kind !== 'text') throw new Error('expected text')
    copiedRecipe.layers[0].content.typography!.warp!.bend = 90
    copiedRecipe.layers[0].content.typography!.fontFamily = 'Different Local Font'
    expect(textOf(saved.nodes[0]).typography).toMatchObject({ fontFamily: 'R43 Local Font', warp: { bend: -65 } })
    expect(textOf(second.nodes[0])).toEqual(textOf(saved.nodes[0]))
  })
  it('inserts the entire template as one history step and restores exact typography on undo and redo', () => {
    const saved = sanitizeWorkshopWorkflow(workflow(), 'group', '全部文字变形')
    let next = 0
    const copy = instantiateWorkshopGraph(saved, () => `history-${++next}`), nodes = records(copy)
    const initial = createCanvasHistory(createCanvasDocument('编辑中工程'))
    const inserted = applyCanvasCommand(initial, { type: 'add-nodes', nodes })
    expect(inserted.past).toHaveLength(1)
    expect(inserted.present.nodes).toHaveLength(13)
    const undone = undoCanvasHistory(inserted)
    expect(undone.present.nodes).toHaveLength(0)
    const redone = redoCanvasHistory(undone)
    expect(redone.present.nodes).toEqual(inserted.present.nodes)
    const changedRecipe = recipe('wave')
    if (changedRecipe.layers[0].content?.kind !== 'text') throw new Error('expected text')
    changedRecipe.layers[0].content.typography!.letterSpacing = -4
    const changed = applyCanvasCommand(redone, { type: 'update-node-data', nodeId: nodes[0].id, patch: { settings: { imageTransform: changedRecipe } } })
    expect(changed.past).toHaveLength(2)
    expect(changed.present.nodes[0].data.settings).toEqual({ imageTransform: changedRecipe })
    expect(undoCanvasHistory(changed).present.nodes[0]).toEqual(redone.present.nodes[0])
    expect(redoCanvasHistory(undoCanvasHistory(changed)).present.nodes).toEqual(changed.present.nodes)
  })
  it('keeps legacy text canonical bytes and omits new defaults in project and workshop copies', () => {
    const original = recipe(), serialized = JSON.stringify(original)
    expect(JSON.stringify(parseImageTransformRecipe(original))).toBe(serialized)
    const source = workflow(); source.nodes = [source.nodes[0]]; source.nodes[0].data.settings = { imageTransform: original }
    const copied = instantiateWorkshopGraph(sanitizeWorkshopWorkflow(restore(source), 'node', '旧文字'), () => 'legacy-copy')
    expect(JSON.stringify(copied.nodes[0].data.settings?.imageTransform)).toBe(serialized)
    expect(JSON.stringify(copied)).not.toContain('typography')
  })
  it('rejects malformed typography as a whole workflow instead of dropping its text node', () => {
    const source = workflow(), value = source.nodes[5].data.settings!.imageTransform as ImageLayerRecipe
    if (value.layers[0].content?.kind !== 'text') throw new Error('expected text')
    value.layers[0].content.typography!.version = 2 as 1
    expect(() => serializeWorkflow(source)).toThrow('版本')
    expect(sanitizeWorkflowV2(source)).toBeNull()
    expect(() => sanitizeWorkshopWorkflow(source, 'group', '不支持版本')).toThrow('版本')
  })
})

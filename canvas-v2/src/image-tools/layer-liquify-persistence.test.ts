import { describe, expect, it } from 'vitest'
import { liquifyRecipeFixture } from '../lib/liquify.test-fixture'
import { sanitizeWorkshopWorkflow, workshopNodeKinds } from '../lib/workshop-sanitizer'
import { buildWorkshopTransferFile, parseWorkshopTransferFile, serializeWorkshopTransferFile } from '../lib/workshop-transfer-format'
import { instantiateWorkshopGraph } from '../editor/workshop-graph'
import { createEmptyWorkflow, parseWorkflowFile, serializeWorkflow, type WorkflowFile } from '../model'
import { createLayerEditorState, patchEditorLayer, redoLayerEditor, undoLayerEditor } from './layer-editor-state'
import type { ImageLayerRecipe } from './recipe'

function graph(): WorkflowFile {
  return { ...createEmptyWorkflow('Liquid'), nodes: [
    { id: 'input', kind: 'image-input', position: { x: 0, y: 0 }, data: { prompt: '', model: '', status: 'succeeded', result: { kind: 'image', assetId: 'a'.repeat(43), localUrl: 'xingmang-asset://image/private' } } },
    { id: 'layer', kind: 'image-layer', position: { x: 400, y: 0 }, data: { prompt: '', model: '', status: 'idle', settings: { imageTransform: liquifyRecipeFixture(), apiKey: 'private-secret' } } },
  ], edges: [{ id: 'edge', source: 'input', sourceHandle: 'out:image', target: 'layer', targetHandle: 'in:images' }] }
}
describe('liquify project, history and portable workshop persistence', () => {
  it('preserves old/new/old operation order through project saves and deep asset-free workshop copies', () => {
    const original = graph(), encoded = serializeWorkflow(original), restored = parseWorkflowFile(encoded)!
    expect(serializeWorkflow(restored)).toBe(encoded)
    expect(restored.nodes[1].data.settings?.imageTransform).toEqual(liquifyRecipeFixture())
    const workshop = sanitizeWorkshopWorkflow(restored, 'group', 'Liquid'), copied = instantiateWorkshopGraph(workshop, (() => { let id = 0; return () => `copy-${++id}` })())
    const recipe = copied.nodes[1].data.settings!.imageTransform as ImageLayerRecipe
    expect(recipe).toEqual(liquifyRecipeFixture())
    const operation = recipe.layers[0].edits!.operations[1]
    if (operation.mode !== 'liquify') throw new Error('expected ordered liquid edit')
    operation.strokes[0].points[0][0] = 1
    expect(workshop.nodes[1].data.settings?.imageTransform).toEqual(liquifyRecipeFixture())
    expect(JSON.stringify(workshop)).not.toMatch(/assetId|localUrl|private-secret/)
    expect(copied.edges).toMatchObject([{ source: copied.nodes[0].id, target: copied.nodes[1].id }])
  })
  it('uses portable v5 only for liquify and keeps repeated exports deterministic', () => {
    const source = graph(), snapshot = { kind: 'group' as const, name: 'Liquid', description: '', category: 'general', tags: [], nodeCount: 2, edgeCount: 1, nodeKinds: workshopNodeKinds(source), workflow: source }
    const file = buildWorkshopTransferFile(snapshot, { kind: 'personal' }), encoded = serializeWorkshopTransferFile(file)
    expect(file.version).toBe(5)
    expect(encoded).not.toMatch(/assetId|localUrl|private-secret/)
    for (let i = 0; i < 3; i++) {
      const read = parseWorkshopTransferFile(encoded)
      expect(read.snapshot.workflow?.nodes[1].data.settings?.imageTransform).toEqual(liquifyRecipeFixture())
      expect(serializeWorkshopTransferFile(buildWorkshopTransferFile(read.snapshot, { kind: 'personal' }))).toBe(encoded)
    }
    const recipe = source.nodes[1].data.settings!.imageTransform as ImageLayerRecipe
    recipe.layers[0].edits!.operations.splice(1, 1)
    expect(buildWorkshopTransferFile(snapshot, { kind: 'personal' }).version).toBe(1)
    for (const version of [6, 7, 8, 9]) {
      const newerEnvelope = JSON.parse(encoded); newerEnvelope.version = version
      const canonical = parseWorkshopTransferFile(JSON.stringify(newerEnvelope))
      expect(canonical.version).toBe(5)
      expect(canonical.snapshot.workflow?.nodes[1].data.settings?.imageTransform).toEqual(liquifyRecipeFixture())
    }
    const unknown = JSON.parse(encoded); unknown.version = 12
    expect(() => parseWorkshopTransferFile(JSON.stringify(unknown))).toThrow('版本')
    unknown.version = 5; unknown.snapshot.workflow.nodes[1].data.settings.imageTransform.layers[0].edits.operations[1].version = 9
    expect(() => parseWorkshopTransferFile(JSON.stringify(unknown))).toThrow('版本')
  })
  it('commits a completed multi-stroke liquid edit once and restores both sides of history', () => {
    const initial = liquifyRecipeFixture(), without = structuredClone(initial)
    without.layers[0].edits!.operations.splice(1, 1)
    const state = createLayerEditorState(without, 1), complete = patchEditorLayer(state, state.present.selectedId!, { edits: initial.layers[0].edits })
    expect(complete.past).toHaveLength(1)
    expect(undoLayerEditor(complete).present.recipe).toEqual(without)
    expect(redoLayerEditor(undoLayerEditor(complete)).present.recipe).toEqual(initial)
  })
})

import { describe, expect, it } from 'vitest'
import type { CanvasWorkshopItem } from '../host'
import { parseWorkflowFile, serializeWorkflow } from '../model'
import { sanitizeWorkshopWorkflow } from '../lib/workshop-sanitizer'
import { defaultImageCropEditorPreferences, parseImageCropEditorPreferences, reconcileUnlockedCropOutputRatio } from './crop-editor-preferences'
import { adaptCropPresetToSource, assertCropPresetReceipt, buildCropPresetWorkflow, cropPresetConfiguration, isCropPresetSummary, readCropPreset } from './crop-presets'
import { cropPixelRatio, fitCropRatio } from './crop-editor-state'
import { defaultImageTransformRecipe, type ImageCropRecipe } from './recipe'

const recipe: ImageCropRecipe = { ...defaultImageTransformRecipe('crop') as ImageCropRecipe, x: .1, y: .2, width: .7, height: .5, rotation: 90, flipX: true, outputWidth: 2048, outputHeight: 1152 }
const preferences = { ...defaultImageCropEditorPreferences(recipe), ratioMode: '自定义' as const, customWidth: 14, customHeight: 9, cropLocked: true, outputLocked: false, outputRatio: 7 / 5, snapping: false }

function item(): CanvasWorkshopItem {
  return { id: 'item', kind: 'node', name: '商品裁剪', description: '', category: 'general', tags: [], version: 1, nodeCount: 1, edgeCount: 0, nodeKinds: ['image-crop'], createdAt: '2026-10-14', updatedAt: '2026-10-14', workflow: buildCropPresetWorkflow('商品裁剪', recipe, preferences) }
}

describe('crop editor preferences and reusable presets', () => {
  it.each([
    { outputWidth: 819, outputHeight: 1024, outputRatio: .8 },
    { outputWidth: 1024, outputHeight: 731, outputRatio: 1.4 },
    { outputWidth: 1, outputHeight: 1024, outputRatio: 1 / 4096 },
  ])('keeps an unlocked exact ratio represented by rounded dimensions: %j', ({ outputWidth, outputHeight, outputRatio }) => {
    const saved = { ...preferences, outputLocked: false, outputRatio }
    expect(reconcileUnlockedCropOutputRatio({ ...recipe, outputWidth, outputHeight }, saved)).toBe(saved)
  })

  it('only reconciles mismatched legacy ratios when the output was unlocked', () => {
    const saved = { ...preferences, outputLocked: false, outputRatio: 821 / 1024 }
    expect(reconcileUnlockedCropOutputRatio({ ...recipe, outputWidth: 800, outputHeight: 1000 }, saved).outputRatio).toBe(.8)
    const locked = { ...saved, outputLocked: true }
    expect(reconcileUnlockedCropOutputRatio({ ...recipe, outputWidth: 800, outputHeight: 1000 }, locked)).toBe(locked)
    expect(saved.outputRatio).toBe(821 / 1024)
  })

  it('keeps legacy defaults without altering the executable recipe', () => {
    const legacy = cropPresetConfiguration(recipe)
    expect(legacy.preferences).toEqual({ version: 1, ratioMode: '自由', customWidth: 7, customHeight: 5, cropLocked: false, outputLocked: true, outputRatio: 2048 / 1152, snapping: true })
    expect(legacy.recipe).toEqual(recipe)
    expect(Object.keys(legacy.recipe)).not.toContain('imageCropEditor')
  })

  it.each([
    { version: 2 }, { ratioMode: '16:10' }, { customWidth: 0 }, { customHeight: 101 }, { customWidth: Infinity },
    { outputRatio: 0 }, { outputRatio: 5000 }, { outputRatio: NaN }, { cropLocked: 1 }, { outputLocked: null }, { snapping: 'true' },
    { endpoint: 'https://untrusted.invalid' }, { apiKey: 'private-key' },
  ])('rejects invalid or additional editing capability fields: %j', (patch) => {
    expect(() => parseImageCropEditorPreferences({ ...preferences, ...patch })).toThrow('裁剪编辑')
  })

  it('persists every editing preference across save, reload and workshop sanitization', () => {
    const workflow = buildCropPresetWorkflow('商品裁剪', recipe, preferences)
    const reloaded = parseWorkflowFile(serializeWorkflow(workflow))!
    expect(reloaded.nodes[0].data.settings).toEqual({ imageTransform: recipe, imageCropEditor: preferences })
    const saved = sanitizeWorkshopWorkflow(workflow, 'node', '商品裁剪')
    expect(saved.nodes[0].data.settings).toEqual({ imageTransform: recipe, imageCropEditor: preferences })
    expect(readCropPreset({ ...item(), workflow: saved })).toEqual({ recipe, preferences })
  })

  it('constructs one unconnected node without model, input, output or old runtime fields', () => {
    const workflow = buildCropPresetWorkflow('  商品裁剪  ', recipe, preferences)
    expect(workflow.name).toBe('商品裁剪')
    expect(workflow.nodes).toHaveLength(1)
    expect(workflow.edges).toEqual([])
    expect(workflow.nodes[0].data).toEqual({ prompt: '', model: '', status: 'idle', settings: { imageTransform: recipe, imageCropEditor: preferences } })
    expect(workflow.nodes[0].position).toEqual({ x: 0, y: 0 })
    expect(() => buildCropPresetWorkflow(' ', recipe, preferences)).toThrow('名称')
    expect(() => buildCropPresetWorkflow('x'.repeat(161), recipe, preferences)).toThrow('名称')
  })

  it('extracts only whitelisted configuration even when a legacy node contains output or source data', () => {
    const saved = item()
    saved.workflow.nodes[0].data = { ...saved.workflow.nodes[0].data, model: 'private-model', group: 'private-provider', prompt: 'old prompt', status: 'succeeded', result: { kind: 'image', assetId: 'a'.repeat(43) }, candidateAssetIds: ['a'.repeat(43)] }
    const before = structuredClone(saved)
    const configuration = readCropPreset(saved)
    expect(configuration).toEqual({ recipe, preferences })
    expect(JSON.stringify(configuration)).not.toMatch(/private-model|private-provider|old prompt|assetId|candidate/)
    expect(saved).toEqual(before)
    configuration.recipe.x = 0
    expect(saved.workflow.nodes[0].data.settings?.imageTransform).toEqual(recipe)
  })

  it('rejects foreign node types, grouped recipes, archived items and missing crop settings', () => {
    for (const patch of [{ kind: 'group' as const }, { deletedAt: '2026-10-14' }, { nodeCount: 2 }, { edgeCount: 1 }, { nodeKinds: ['image-layer' as const] }]) {
      expect(isCropPresetSummary({ ...item(), ...patch })).toBe(false)
      expect(() => readCropPreset({ ...item(), ...patch })).toThrow('裁剪预设')
    }
    const invalid = item()
    invalid.workflow.nodes[0].kind = 'image-layer'
    expect(() => readCropPreset(invalid)).toThrow('参数')
    invalid.workflow.nodes[0].kind = 'image-crop'
    invalid.workflow.nodes[0].data.settings = { imageTransform: defaultImageTransformRecipe('layer') }
    expect(() => readCropPreset(invalid)).toThrow('裁剪节点')
    invalid.workflow.nodes[0].data.settings = {}
    expect(() => readCropPreset(invalid)).toThrow('参数')
    invalid.workflow.nodes[0].data.settings = { imageTransform: recipe }
    invalid.workflow.nodes[0].disabled = true
    expect(() => readCropPreset(invalid)).toThrow('参数')
  })

  it('rejects a save receipt for a different configuration while permitting server name redaction', () => {
    const saved = item()
    const input = { operationId: 'operation', kind: 'node' as const, name: 'Original name', workflow: saved.workflow }
    expect(() => assertCropPresetReceipt(saved, input)).not.toThrow()
    const wrong = item()
    wrong.workflow.nodes[0].data.settings!.imageTransform = { ...recipe, outputWidth: 100 }
    expect(() => assertCropPresetReceipt(wrong, input)).toThrow('回执')
  })

  it.each([
    [{ width: 603, height: 401 }, { width: 400, height: 600 }],
    [{ width: 400, height: 600 }, { width: 603, height: 401 }],
  ])('adapts custom crop ratios between source orientations without replacing explicit output sizes', (previous, current) => {
    const configured = { recipe: fitCropRatio({ ...recipe, rotation: 0, outputWidth: 700, outputHeight: 500 }, previous, 7 / 5), preferences: { ...preferences, customWidth: 7, customHeight: 5 } }
    const before = structuredClone(configured)
    const adapted = adaptCropPresetToSource(configured, current)
    expect(cropPixelRatio(adapted.recipe, current)).toBeCloseTo(7 / 5, 10)
    expect(adapted.recipe).toMatchObject({ outputWidth: 700, outputHeight: 500, rotation: 0, flipX: true })
    expect(adapted.recipe.x + adapted.recipe.width).toBeLessThanOrEqual(1)
    expect(adapted.recipe.y + adapted.recipe.height).toBeLessThanOrEqual(1)
    expect(adapted.preferences).toEqual(configured.preferences)
    expect(configured).toEqual(before)
  })

  it('keeps quarter-turn rotation, flips and output sizing while adapting a named ratio', () => {
    const configuration = { recipe: { ...recipe, flipY: true, outputWidth: 900, outputHeight: 1600 }, preferences: { ...preferences, ratioMode: '16:9' as const } }
    const adapted = adaptCropPresetToSource(configuration, { width: 400, height: 600 })
    expect(cropPixelRatio(adapted.recipe, { width: 400, height: 600 })).toBeCloseTo(16 / 9, 10)
    expect(adapted.recipe).toMatchObject({ rotation: 90, flipX: true, flipY: true, outputWidth: 900, outputHeight: 1600 })
    expect(adapted.preferences).toEqual(configuration.preferences)
  })

  it('uses the current source aspect for original mode and retains the crop center where it fits', () => {
    const configuration = { recipe, preferences: { ...preferences, ratioMode: '原图' as const } }
    const adapted = adaptCropPresetToSource(configuration, { width: 400, height: 600 })
    expect(adapted.recipe).toEqual({ ...recipe, x: 0, y: 0, width: 1, height: 1 })
    const centered = adaptCropPresetToSource({ recipe: { ...recipe, y: .4, height: .4 }, preferences: { ...preferences, ratioMode: '1:1' } }, { width: 400, height: 600 })
    expect(centered.recipe.y + centered.recipe.height / 2).toBeCloseTo(.6)
    expect(centered.preferences.ratioMode).toBe('1:1')
  })

  it('retains free-mode relative ranges and all editing preferences', () => {
    const configuration = { recipe, preferences: { ...preferences, ratioMode: '自由' as const } }
    expect(adaptCropPresetToSource(configuration, { width: 400, height: 600 })).toEqual(configuration)
  })

  it.each([undefined, { width: 0, height: 600 }, { width: NaN, height: 600 }, { width: 400, height: Infinity }])('rejects unknown or invalid source dimensions before applying a preset: %j', (source) => {
    expect(() => adaptCropPresetToSource({ recipe, preferences }, source)).toThrow('原图尺寸')
  })
})

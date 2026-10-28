import { describe, expect, it } from 'vitest'
import { createEmptyWorkflow, type WorkflowFile } from '../model'
import type { ImageLayer, ImageLayerRecipe } from '../image-tools/recipe'
import { toPersistedWorkflowV2 } from '../persistence/workflow-schema'
import { sanitizeWorkflowV2 } from '../persistence/workflow-sanitizer'
import { sanitizeWorkshopWorkflow, workshopText, workshopPromptText, maximumWorkshopBytes } from './workshop-sanitizer'
import { officialPromptSnapshot, promptDocument, replacePromptSelection } from '../library/prompt-references'
import { defaultImageTransformRecipe } from '../image-tools/recipe'
import { defaultImageCropEditorPreferences } from '../image-tools/crop-editor-preferences'
import { instantiateWorkshopGraph } from '../editor/workshop-graph'

function workflow(): WorkflowFile {
  return { ...createEmptyWorkflow('Original'), mediaGroups: { image: 'private-provider', imageModel: 'gpt-image-2' },
    nodes: [{ id: 'original-node', kind: 'image-generate', definitionVersion: 1, position: { x: 10, y: 20 }, data: {
      prompt: 'A coffee cup', model: 'gpt-image-2', status: 'succeeded', quality: 'high', size: '16:9', imageResolution: '4K',
      result: { kind: 'image', assetId: 'a'.repeat(43), localUrl: 'https://secret.example/result', taskId: 'private-task' }, candidateAssetIds: ['a'.repeat(43)],
      settings: { assetId: 'a'.repeat(43), apiKey: 'private-key', output: 'private-output', nested: { accessToken: 'private-token' }, random: 'private' },
    } }], edges: [] }
}

describe('workshop configuration whitelist', () => {
  it('round trips explicit native audio and large video options without carrying source identity', () => {
    const source = workflow()
    source.nodes[0].kind = 'video-generate'
    source.nodes[0].data = { ...source.nodes[0].data, model: 'grok-imagine-video-1.5', videoCandidateCount: 3, settings: { generateAudio: false, videoResolution: '1080p', videoAspectRatio: '5:2', videoProtocol: 'xai-native', providerId: 'private-provider' } }
    const saved = sanitizeWorkshopWorkflow(source, 'node', 'Silent video')
    expect(saved.nodes[0].data.settings).toEqual({ generateAudio: false, videoResolution: '1080p', videoAspectRatio: '5:2' })
    expect(saved.nodes[0].data.videoCandidateCount).toBe(3)
    expect(saved.nodes[0].data.result).toBeUndefined()
    const portable = sanitizeWorkshopWorkflow(saved, 'node', 'Silent video')
    expect(portable).toEqual(saved)
    const persisted = toPersistedWorkflowV2(portable)
    expect(sanitizeWorkflowV2(persisted)?.workflow.nodes[0].data.settings?.generateAudio).toBe(false)
    source.nodes[0].data.settings!.generateAudio = 'false'
    expect(() => sanitizeWorkshopWorkflow(source, 'node', 'Invalid')).toThrow('音频')
  })

  it('preserves whitespace and exact official-reference offsets while retaining secret redaction', () => {
    const official = officialPromptSnapshot('xingmang-product-studio')!
    const document = replacePromptSelection(promptDocument(' \n\t'), 3, 3, '', official).document
    const source = workflow(); source.nodes[0].kind = 'prompt'
    source.nodes[0].data.prompt = document.prompt + '\n\n'
    source.nodes[0].data.promptReferences = document.references
    const reusable = sanitizeWorkshopWorkflow(source, 'node', '正文').nodes[0].data
    expect(reusable.prompt).toBe(source.nodes[0].data.prompt)
    expect(reusable.promptReferences).toEqual(document.references)
    expect(workshopPromptText(' \n正文 password=secret\n\t', '正文', 24000)).toBe(' \n正文 password=[已隐藏密钥]\n\t')
    expect(workshopText('  名称  ', '名称', 160)).toBe('名称')
    expect(() => workshopPromptText(' \r\n ', '正文', 24000)).toThrow()
    expect(() => workshopPromptText('正文\0', '正文', 24000)).toThrow()
    expect(() => workshopPromptText('字'.repeat(24000) + ' ', '正文', 24000)).toThrow()
  })
  it('preserves collage styles but redacts watermark secrets before portable snapshots', () => {
    const source = workflow()
    source.nodes[0].kind = 'image-collage'
    source.nodes[0].data.settings = { imageTransform: { ...defaultImageTransformRecipe('collage'), layout: 'horizontal', autoSize: true, cornerRadius: 24, borderWidth: 4, borderColor: '#ffcc00', shadow: true, watermark: { text: '品牌 https://shop.test password=x', color: '#ffffff', opacity: .25, fontSize: 24 } } }
    const saved = sanitizeWorkshopWorkflow(source, 'node', 'Collage')
    const recipe = saved.nodes[0].data.settings?.imageTransform
    expect(recipe).toMatchObject({ layout: 'horizontal', autoSize: true, cornerRadius: 24, borderWidth: 4, borderColor: '#ffcc00', shadow: true, watermark: { color: '#ffffff', opacity: .25, fontSize: 24 } })
    expect(JSON.stringify(recipe)).toContain('https://shop.test')
    expect(JSON.stringify(recipe)).not.toContain('password=x')
    expect(saved.nodes[0].data.result).toBeUndefined()
    expect(JSON.stringify(saved)).not.toContain('private-provider')
    expect(sanitizeWorkshopWorkflow(saved, 'node', 'Collage')).toEqual(saved)
    expect(sanitizeWorkflowV2(toPersistedWorkflowV2(saved))?.workflow.nodes[0].data.settings?.imageTransform).toEqual(recipe)
  })

  it('bounds metadata and general settings after fully redacting secrets without cutting a surrogate pair', () => {
    for (const limit of [40, 160, 4000, 24_000]) {
      const text = 'password=x ' + '品'.repeat(limit - 11)
      const safe = workshopText(text, '文本', limit)
      expect(safe).toHaveLength(limit)
      expect(safe).not.toContain('password=x')
      expect(workshopText(safe, '文本', limit)).toBe(safe)
    }
    const unicode = workshopText('password=x ' + '品'.repeat(22) + '😀'.repeat(3), '标签', 40)
    expect(unicode).not.toMatch(/[\uD800-\uDBFF]$/)
    const source = workflow()
    source.nodes[0].data.prompt = 'password=x ' + '产'.repeat(23_989)
    source.nodes[0].data.model = 'password=x ' + 'm'.repeat(501)
    source.nodes[0].data.settings = { title: 'password=x ' + '名'.repeat(149) }
    const saved = sanitizeWorkshopWorkflow(source, 'node', 'Reusable')
    expect(saved.nodes[0].data.prompt).toHaveLength(24_000)
    expect(saved.nodes[0].data.model).toHaveLength(512)
    expect(saved.nodes[0].data.settings?.title).toHaveLength(160)
    expect(sanitizeWorkshopWorkflow(saved, 'node', 'Reusable')).toEqual(saved)
    expect(JSON.stringify(saved)).not.toContain('password=x')
  })

  it('rejects aggregate redaction expansion before storing an unreadable workflow', () => {
    const source = workflow()
    source.nodes = Array.from({ length: 25 }, (_, index) => ({ ...source.nodes[0], id: String(index), data: { prompt: 'password=x '.repeat(1800), model: '', status: 'idle' } }))
    expect(new TextEncoder().encode(JSON.stringify(source)).byteLength).toBeLessThan(maximumWorkshopBytes)
    expect(() => sanitizeWorkshopWorkflow(source, 'group', 'Redacted')).toThrow('脱敏后的节点配置超过')
  })

  it('preserves disabled model nodes through sanitization and insertion without retaining their previous outputs', () => {
    const source = workflow()
    source.nodes[0].disabled = true
    source.nodes[0].locked = true
    const saved = sanitizeWorkshopWorkflow(source, 'node', 'Disabled')
    const inserted = instantiateWorkshopGraph(saved, () => 'fresh-node')
    expect(inserted.nodes[0]).toMatchObject({ id: 'fresh-node', disabled: true, data: { status: 'idle' } })
    expect(inserted.nodes[0].data.result).toBeUndefined()
    expect(inserted.nodes[0].locked).toBeUndefined()
    expect(() => sanitizeWorkshopWorkflow({ ...source, nodes: [{ ...source.nodes[0], disabled: 'false' }] }, 'node', 'Invalid')).toThrow('禁用状态')
  })

  it('keeps prose settings inside the generic reader limit instead of silently dropping them', () => {
    const source = workflow()
    source.nodes[0].kind = 'drama-character'
    source.nodes[0].data.settings = { appearance: 'password=x ' + '貌'.repeat(9989) }
    const saved = sanitizeWorkshopWorkflow(source, 'node', 'Character')
    expect(saved.nodes[0].data.settings?.appearance).toHaveLength(10_000)
    expect(sanitizeWorkshopWorkflow(saved, 'node', 'Character')).toEqual(saved)
    source.nodes[0].data.settings.appearance = '貌'.repeat(10_001)
    expect(() => sanitizeWorkshopWorkflow(source, 'node', 'Character')).toThrow('10000')
  })

  it('round-trips strictly validated crop editor preferences separately from the executable recipe', () => {
    const recipe = defaultImageTransformRecipe('crop')
    if (recipe.kind !== 'crop') throw new Error('unexpected fixture')
    const preferences = { ...defaultImageCropEditorPreferences(recipe), ratioMode: '自定义' as const, customWidth: 7, customHeight: 5, cropLocked: true, outputLocked: false, snapping: false }
    const source = workflow()
    source.nodes[0].kind = 'image-crop'
    source.nodes[0].data.settings = { imageTransform: recipe, imageCropEditor: preferences }
    const saved = sanitizeWorkshopWorkflow(source, 'node', 'Crop')
    expect(saved.nodes[0].data.settings).toEqual({ imageTransform: recipe, imageCropEditor: preferences })
    const persisted = toPersistedWorkflowV2(saved)
    expect(sanitizeWorkflowV2(persisted)?.workflow.nodes[0].data.settings).toEqual(saved.nodes[0].data.settings)
    for (const invalid of [{ ...preferences, secret: 'hidden' }, { ...preferences, outputRatio: Infinity }, { ...preferences, cropLocked: 'yes' }]) {
      source.nodes[0].data.settings.imageCropEditor = invalid
      expect(() => sanitizeWorkshopWorkflow(source, 'node', 'Invalid')).toThrow('裁剪编辑偏好')
      expect(() => toPersistedWorkflowV2(source)).toThrow('裁剪')
      const malformed = structuredClone(persisted)
      malformed.nodes[0].data.settings = { imageTransform: recipe, imageCropEditor: invalid }
      expect(sanitizeWorkflowV2(malformed)).toBeNull()
    }
  })

  function layerRecipe(text = '  新品上市\n第二件半价 https://shop.example.test  '): ImageLayerRecipe {
    const base: ImageLayer = { sourceIndex: 19, x: 0, y: 0, width: .8, height: .6, rotation: 45, opacity: .8, blend: 'screen', visible: true, name: '商品标题', locked: true, flipX: true, flipY: false, adjustments: { brightness: 1.2, contrast: .8, saturation: 1.5, blur: 3, grayscale: .1 } }
    return { kind: 'layer', outputWidth: 1200, outputHeight: 800, background: 'transparent', explicitLayers: true, layers: [
      { ...base, content: { kind: 'text', text, color: '#ffffff', fontSize: 64, fontFamily: 'serif', fontWeight: 700, align: 'center' } },
      { ...base, sourceIndex: 0, name: '圆形底板', content: { kind: 'shape', shape: 'ellipse', fill: '#ff0000', stroke: '#ffffff', strokeWidth: 3 } },
    ] }
  }
  function imageLayerWorkflow(recipe: ImageLayerRecipe): WorkflowFile {
    const source = workflow()
    source.nodes[0].kind = 'image-layer'
    source.nodes[0].data.settings = { imageTransform: recipe }
    return source
  }

  it('round-trips advanced layer configuration through project and workshop parsers without changing product text', () => {
    const recipe = layerRecipe()
    const source = imageLayerWorkflow(recipe)
    const persisted = toPersistedWorkflowV2(source)
    const reopened = sanitizeWorkflowV2(persisted)!
    expect(reopened.warnings).toEqual([])
    expect(reopened.workflow.nodes[0].data.settings?.imageTransform).toEqual(recipe)
    const saved = sanitizeWorkshopWorkflow(reopened.workflow, 'node', 'Layer design')
    expect(saved.nodes[0].data.settings?.imageTransform).toEqual(recipe)
    expect(saved.nodes[0].data.result).toBeUndefined()
    expect(saved.nodes[0].data.candidateAssetIds).toBeUndefined()
    expect(saved.nodes[0].data.group).toBeUndefined()
    expect(source.nodes[0].data.settings?.imageTransform).toEqual(recipe)
  })

  it('redacts only credential-shaped text and names while preserving layout and ordinary product prose', () => {
    const recipe = layerRecipe('新品 https://shop.example.test\nBearer synthetic-bearer-token\napi_key=synthetic-secret\nsk-synthetic-secret-for-testing123')
    recipe.layers[0].name = '标题 sk-synthetic-secret-for-testing123'
    const saved = sanitizeWorkshopWorkflow(imageLayerWorkflow(recipe), 'node', 'Reusable')
    const actual = saved.nodes[0].data.settings?.imageTransform as ImageLayerRecipe
    expect(actual.layers[0].name).toBe('标题 [已隐藏密钥]')
    expect(actual.layers[0].content).toEqual({ ...recipe.layers[0].content, text: '新品 https://shop.example.test\n[已隐藏授权信息]\napi_key=[已隐藏密钥]\n[已隐藏密钥]' })
    expect({ ...actual.layers[0], name: undefined, content: undefined }).toEqual({ ...recipe.layers[0], name: undefined, content: undefined })
    expect(JSON.stringify(recipe)).toContain('synthetic-bearer-token')
    expect(JSON.stringify(actual)).not.toContain('synthetic')
  })

  it('preserves twenty full-length Chinese text layers and rejects unrecognized nested capabilities', () => {
    const recipe = layerRecipe('商'.repeat(2000))
    recipe.layers = Array.from({ length: 20 }, (_, sourceIndex) => ({ ...recipe.layers[0], sourceIndex }))
    const source = imageLayerWorkflow(recipe)
    expect(new TextEncoder().encode(JSON.stringify(source)).byteLength).toBeGreaterThan(64 * 1024)
    expect(sanitizeWorkshopWorkflow(source, 'node', 'Full text').nodes[0].data.settings?.imageTransform).toEqual(recipe)
    source.nodes[0].data.settings = { imageTransform: { ...recipe, layers: [{ ...recipe.layers[0], content: { ...recipe.layers[0].content, imageUrl: 'https://untrusted.example/image.png' } }] } }
    expect(() => sanitizeWorkshopWorkflow(source, 'node', 'Bad')).toThrow()
  })

  it('keeps maximum-length fields usable when redacting short secrets expands their text', () => {
    const recipe = layerRecipe('password=x ' + '产'.repeat(1989))
    recipe.layers[0].name = 'password=x ' + '品'.repeat(69)
    expect(recipe.layers[0].name).toHaveLength(80)
    const saved = sanitizeWorkshopWorkflow(imageLayerWorkflow(recipe), 'node', 'Redacted maximum')
    const actual = saved.nodes[0].data.settings?.imageTransform as ImageLayerRecipe
    expect(actual.layers[0].name).toHaveLength(80)
    expect(actual.layers[0].name).toMatch(/^password=\[已隐藏密钥\] /)
    expect(actual.layers[0].content?.kind).toBe('text')
    if (actual.layers[0].content?.kind !== 'text') throw new Error('unexpected fixture content')
    expect(actual.layers[0].content.text).toHaveLength(2000)
    expect(actual.layers[0].content.text).toMatch(/^password=\[已隐藏密钥\] /)
    expect(sanitizeWorkshopWorkflow(saved, 'node', 'Reused maximum').nodes[0].data.settings?.imageTransform).toEqual(actual)
    expect(JSON.stringify(actual)).not.toContain('password=x')
  })

  it('retains useful generation parameters while removing provider identity, outputs, and arbitrary settings', () => {
    const source = workflow()
    const sanitized = sanitizeWorkshopWorkflow(source, 'node', 'Product image')
    expect(sanitized).toEqual({ schemaVersion: 2, name: 'Product image', nodes: [{ id: 'node-1', kind: 'image-generate', definitionVersion: 1, position: { x: 10, y: 20 }, data: { prompt: 'A coffee cup', model: 'gpt-image-2', status: 'idle', quality: 'high', size: '16:9', imageResolution: '4K' } }], edges: [] })
    expect(JSON.stringify(sanitized)).not.toMatch(/private|https:|assetId|result|candidate|mediaGroups/)
    expect(source.nodes[0].data.result?.assetId).toBe('a'.repeat(43))
  })

  it('preserves internal group edges and remaps identifiers without retaining old run identifiers', () => {
    const source: WorkflowFile = { ...createEmptyWorkflow('Group'), nodes: [
      { id: 'group-private', kind: 'group', definitionVersion: 1, position: { x: 20, y: 20 }, width: 700, height: 400, data: { prompt: '', model: '', status: 'idle', settings: { title: '商品摄影', assetId: 'private' } } },
      { id: 'text-private', parentId: 'group-private', kind: 'prompt', definitionVersion: 1, position: { x: 20, y: 40 }, data: { prompt: '产品描述', model: '', status: 'succeeded' } },
      { ...workflow().nodes[0], parentId: 'group-private', position: { x: 350, y: 40 } },
    ], edges: [{ id: 'edge-private', source: 'text-private', sourceHandle: 'out:text', target: 'original-node', targetHandle: 'in:text' }] }
    const sanitized = sanitizeWorkshopWorkflow(source, 'group', 'Reusable')
    expect(sanitized.nodes[1].parentId).toBe('node-1')
    expect(sanitized.nodes[0].data.settings).toEqual({ title: '商品摄影' })
    expect(sanitized.edges).toEqual([{ id: 'edge-1', source: 'node-2', sourceHandle: 'out:text', target: 'node-3', targetHandle: 'in:text' }])
    expect(JSON.stringify(sanitized)).not.toContain('private')
  })

  it('keeps explicit video options and note prose while stripping credentials and assets at every depth', () => {
    const source = workflow()
    source.nodes[0].kind = 'video-generate'
    source.nodes[0].data.settings = { videoMode: 'fl2va', videoResolution: '720p', videoAspectRatio: '9:16', promptOptimization: false, adoptedAssetId: 'secret', frame: { url: 'https://asset' } }
    expect(sanitizeWorkshopWorkflow(source, 'node', 'Video').nodes[0].data.settings).toEqual({ videoMode: 'fl2va', videoResolution: '720p', videoAspectRatio: '9:16', promptOptimization: false })
    source.nodes[0].kind = 'note'
    source.nodes[0].data.prompt = 'Bearer abcdefghijklmnop'
    source.nodes[0].data.settings = { text: '参考资料 https://example.test 及 sk-synthetic-secret-for-testing123', color: 'warm-white', file: '/Users/private.png', key: 'hidden' }
    const sanitized = sanitizeWorkshopWorkflow(source, 'node', 'Note')
    expect(sanitized.nodes[0].data.prompt).toBe('[已隐藏授权信息]')
    expect(sanitized.nodes[0].data.settings).toEqual({ text: '参考资料 https://example.test 及 [已隐藏密钥]', color: 'warm-white' })
  })

  it('retains node names and reusable shot descriptions without restoring old approval gates', () => {
    const source = workflow()
    source.nodes[0].kind = 'drama-shot'
    source.nodes[0].data.settings = { title: '开场', shotId: 'S01', action: '人物走入画面', framing: '中景', gate: 'ready', compiledPrompt: 'old output', assetIds: ['a'.repeat(43)] }
    expect(sanitizeWorkshopWorkflow(source, 'node', 'Shot').nodes[0].data.settings).toEqual({ title: '开场', shotId: 'S01', action: '人物走入画面', framing: '中景' })
    source.nodes[0].data.settings.title = '名'.repeat(160)
    expect(sanitizeWorkshopWorkflow(source, 'node', 'Shot').nodes[0].data.settings?.title).toHaveLength(160)
  })

  it('rejects unknown nodes, detached groups and lossy edge repairs instead of silently saving a partial template', () => {
    const source = workflow()
    source.nodes[0].parentId = 'missing'
    expect(() => sanitizeWorkshopWorkflow(source, 'node', 'Bad')).toThrow('无效')
    delete source.nodes[0].parentId
    source.nodes[0].kind = 'unknown'
    expect(() => sanitizeWorkshopWorkflow(source, 'node', 'Bad')).toThrow('未知')
    source.nodes[0].kind = 'image-generate'
    source.edges.push({ id: 'edge', source: 'original-node', sourceHandle: 'out:image', target: 'original-node', targetHandle: 'in:images' })
    expect(() => sanitizeWorkshopWorkflow(source, 'group', 'Bad')).toThrow('无效')
  })

  it('enforces node/group semantics and bounded graph storage', () => {
    const source = workflow()
    source.nodes.push({ ...source.nodes[0], id: 'another' })
    expect(() => sanitizeWorkshopWorkflow(source, 'node', 'Bad')).toThrow('一个')
    source.nodes = Array.from({ length: 201 }, (_, index) => ({ ...source.nodes[0], id: String(index) }))
    expect(() => sanitizeWorkshopWorkflow(source, 'group', 'Bad')).toThrow('200')
    source.nodes = [{ ...workflow().nodes[0], data: { ...workflow().nodes[0].data, prompt: 'A'.repeat(600_000) } }]
    expect(() => sanitizeWorkshopWorkflow(source, 'node', 'Bad')).toThrow('512 KB')
    source.nodes = [{ ...workflow().nodes[0], kind: 'group' }]
    expect(() => sanitizeWorkshopWorkflow(source, 'group', 'Bad')).toThrow('内容节点')
  })
})

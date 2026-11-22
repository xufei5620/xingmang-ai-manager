import { describe, expect, it } from 'vitest'
import type { CanvasRunGraph } from './host'
import { resolveCanvasCapabilities, type CanvasHostCapabilities } from './host-capabilities'
import { availableModelsForKind, availableTextModels, withPreferredMediaDefaults, withResolvedMediaModels } from './library/media-groups'
import { availableImageModelPresets, imageModelPreset, imageModelPresets, knownNonImageModel, knownNonTextModel, recognisedImageModel, validateImageModelOptions } from './models'
import { imageModelFamily, listedImageModelFamily } from './runtime/image-model-family'
import { buildImageRequestParameters, imageRequestModelControls } from './runtime/image-request-parameters'
import { inspectImageResolutionSelection } from './runtime/image-resolution-selection'
import { buildCanvasRunPreflight } from './runtime/run-preflight'

// 画布里选不到站上新出的出图型号（0.2.25 总单第 10 项、Mac 验收 R7、桌面 #1368 第 3 条）：桌面 #1920 让对话和主进程
// 按名字认出 Nano Banana、新版 Gemini 出图、seedream / Flux / 通义这些型号，画布内核的型号表没跟上，桌面的分组又
// 不声明用途，图片下拉只剩预设里的那几个。下面几张名字表照抄桌面 electron/ai-chat-protocol.test.ts，两边认的必须一样。
// 桌面 electron/canvas-contract.ts 现在声明的出图清晰度（桌面构建只搬 src/，这里抄一份，不 import contract/ 下的样本）。
const desktopImageResolutions: CanvasHostCapabilities['imageResolutions'] = {
  byModel: {
    'gemini-3.1-flash-image': ['1K', '2K', '4K'],
    'gpt-image-1': ['1K'],
    'gpt-image-2': ['1K', '2K', '4K'],
    'gpt-image-2-2026-04-21': ['1K', '2K', '4K'],
    jimeng_high_aes_general_v21_L: ['1K'],
    'grok-imagine-image': ['1K'],
    'grok-imagine-image-2.0': ['1K'],
    'grok-imagine-image-quality': ['1K'],
  },
  otherGptImage: ['1K', '2K', '4K'],
}
const desktop = resolveCanvasCapabilities({
  contractVersion: 1,
  host: 'desktop',
  executableNodeKinds: ['prompt', 'image', 'image-generate', 'image-edit'],
  features: {
    quote: false, accountSummary: false, imageEditMask: false, textGenerate: false, textWebSearch: false, imageTools: false,
    frameExtract: false, scenarioTemplates: false, routerStrategy: false, generateAudio: false, referenceOrder: false,
    cloud: false, agentExecution: false, byteUpload: false, promptPresetGroups: false,
  },
  imageCandidates: { maximum: 1 },
  videoCandidates: { maximum: 1 },
  promptPresetNameMaxLength: 160,
  imageResolutions: desktopImageResolutions,
  video: { siteIds: ['solov'], protocols: ['relay-videos'], seconds: { minimum: 1, maximum: 15 }, dimensions: ['1280x720'], miniMaxResolutions: ['720p'], miniMaxAspectRatios: ['16:9'] },
} satisfies CanvasHostCapabilities)

const geminiImageModels = ['nano-banana-2', 'nano-banana-pro', 'gemini-3-pro-image-preview', 'gemini-3.2-flash-image', 'Gemini-3.1-Flash-Image-Preview']
const singleResolutionGeminiModels = ['nano-banana', 'gemini-2.5-flash-image', 'gemini-2.0-flash-exp-image-generation']
const imagesApiModels = [
  'dall-e-3', 'imagen-4.0-generate-001', 'qwen-image', 'qwen-image-plus', 'qwen-image-2.0-pro', 'z-image-turbo',
  'wan2.6-t2i', 'wanx2.1-t2i-turbo', 'flux-2-pro', 'flux.1-schnell', 'black-forest-labs/FLUX.1-schnell',
  'black-forest-labs/flux-1.1-pro', 'doubao-seedream-4-0-250828', 'doubao-seedream-3-0-t2i-250415', 'seedream-4.5',
]
const notImageModels = [
  // 只能改图的：出图这条路不带原图。
  'qwen-image-edit', 'qwen-image-edit-plus', 'wan2.6-image', 'wanx2.1-imageedit', 'doubao-seededit-3-0-i2i', 'flux-1-edit',
  // 文字模型，还有名字只是长得像的。
  'gemini-3-pro', 'gemini-2.0-flash-exp', 'gemini-embedding-001', 'proxy-nano-banana-2', 'gemini-image', 'nano-bananas', 'gemini--image',
  'qwen3-max', 'qwen-vl-max', 'doubao-seed-1.6', 'influx-7b', 'midjourney-v7', 'proxy-dall-e-3', 'sora_image', 'minimax-m2',
  // 名字也像视频的照旧不当出图型号（桌面 #1059）。
  'wan2.2-t2v-plus', 'doubao-seedance-1-0-pro', 'flux-video-1', 'nano-banana-video', 'veo-3.1-fast', 'sora-2',
]

// xm「图片模型」分组，次序是站上列的次序；里面混着改图专用、不能用的 1.5、快照版和视频型号。
const xmImageGroup = [
  'nano-banana-pro', 'gpt-image-2', 'gpt-image-2.5-sunburst', 'doubao-seedream-4-0-250828', 'gpt-image-2.6-sunburst',
  'qwen-image-edit', 'gpt-image-2.5-flare', 'gpt-image-1.5', 'gpt-image-2-2026-04-21', 'gpt-image-2.6-flare',
  'flux-2-pro', 'nano-banana-2', 'grok-imagine-video', 'minimax-h3-base',
]

function preflight(kind: 'image-generate' | 'image-edit', model: string, size: string) {
  const graph: CanvasRunGraph = { nodes: [{ id: 'image', kind, definitionVersion: 1, data: { prompt: '一只陶瓷杯', model, group: '图片模型', size, imageResolution: '1K' } }], edges: [] }
  return buildCanvasRunPreflight({ graph, scope: { kind: 'all' }, imageModels: [model], videoModels: [], capabilities: desktop })
}

describe('image models recognised by family', () => {
  it('recognises the same names as the desktop main process', () => {
    for (const model of [...geminiImageModels, ...singleResolutionGeminiModels]) expect(imageModelFamily(model), model).toBe('gemini-image')
    for (const model of imagesApiModels) expect(imageModelFamily(model), model).toBe('images-api')
    for (const model of notImageModels) expect(imageModelFamily(model), model).toBeNull()
    expect(imageModelFamily('gpt-image-3')).toBe('gpt-image')
    expect(imageModelFamily('grok-imagine-image-3')).toBe('grok-image')
    expect(imageModelFamily('jimeng_high_aes_general_v30')).toBe('jimeng')
  })

  it('lists them in a desktop image group after the presets, in the account order', () => {
    // 桌面的分组不声明用途：预设按预设次序，认得出的同家型号接在后面，次序照账号列表。
    expect(availableModelsForKind('image', xmImageGroup)).toEqual([
      'gpt-image-2.6-flare', 'gpt-image-2.5-flare', 'gpt-image-2', 'gpt-image-2.6-sunburst', 'gpt-image-2.5-sunburst',
      'nano-banana-pro', 'doubao-seedream-4-0-250828', 'flux-2-pro', 'nano-banana-2',
    ])
    expect(listedImageModelFamily('gpt-image-1.5')).toBeNull()
    expect(listedImageModelFamily('gpt-image-2-2026-04-21')).toBeNull()
  })

  it('labels GPT Image 2.6 Flare as recommended and makes it the default of a new project when the group has it', () => {
    expect(imageModelPresets.slice(0, 5).map(({ id, label }) => ({ id, label }))).toEqual([
      { id: 'gpt-image-2.6-flare', label: 'GPT Image 2.6 Flare(推荐)' },
      { id: 'gpt-image-2.5-flare', label: 'GPT Image 2.5 Flare' },
      { id: 'gpt-image-2', label: 'GPT Image 2' },
      { id: 'gpt-image-2.6-sunburst', label: 'GPT Image 2.6 Sunburst' },
      { id: 'gpt-image-2.5-sunburst', label: 'GPT Image 2.5 Sunburst' },
    ])
    expect(imageModelPresets.filter((preset) => preset.label.includes('推荐')).map((preset) => preset.id)).toEqual(['gpt-image-2.6-flare'])
    const fresh = withPreferredMediaDefaults({}, [{ name: '图片模型' }, { name: 'Gemini' }])
    expect(withResolvedMediaModels(fresh, availableModelsForKind('image', xmImageGroup), [], []).imageModel).toBe('gpt-image-2.6-flare')
    expect(withResolvedMediaModels(fresh, availableModelsForKind('image', ['gpt-image-2.5-flare', 'gpt-image-2']), [], []).imageModel).toBe('gpt-image-2.5-flare')
    // 分组里只有新认出来的型号时，新项目就用它，不再空着。
    expect(withResolvedMediaModels(fresh, availableModelsForKind('image', ['gpt-5.6-sol', 'nano-banana-2']), [], []).imageModel).toBe('nano-banana-2')
    expect(withResolvedMediaModels({ image: '图片模型', imageModel: 'gpt-image-2' }, availableModelsForKind('image', xmImageGroup), [], []).imageModel).toBe('gpt-image-2')
  })

  it('keeps them out of text model lists and the default text model', () => {
    const gemini = ['gemini-3-pro-image-preview', 'nano-banana-2', 'gemini-3.7-flash', 'flux-2-pro', 'qwen-image']
    expect(availableTextModels(gemini)).toEqual(['gemini-3.7-flash'])
    expect(availableModelsForKind('text', gemini)).toEqual(['gemini-3.7-flash'])
    expect(withResolvedMediaModels({}, [], [], gemini).textModel).toBe('gemini-3.7-flash')
    for (const model of [...geminiImageModels, ...singleResolutionGeminiModels, ...imagesApiModels]) {
      expect(knownNonTextModel(model), model).toBe(true)
      expect(knownNonImageModel(model), model).toBe(false)
      expect(recognisedImageModel(model), model).toBe(true)
    }
  })

  it('treats Gemini image models like Gemini 3.1 Flash Image: ten ratios, no quality, no edits', () => {
    const base = imageModelPreset('gemini-3.1-flash-image')
    for (const model of [...geminiImageModels, ...singleResolutionGeminiModels]) {
      expect(imageModelPreset(model), model).toMatchObject({ id: model, sizes: base.sizes, supportsSize: true, supportsQuality: false, supportsEdits: false, resolutions: ['1K'] })
      expect(imageRequestModelControls(model), model).toEqual({ supportsSize: true, supportsQuality: false })
    }
    expect(imageModelPreset('nano-banana-2').label).toBe('Nano Banana 2')
    expect(imageModelPreset('nano-banana-pro').label).toBe('Nano Banana Pro')
    expect(imageModelPreset('gemini-3-pro-image-preview').label).toBe('gemini-3-pro-image-preview')
    expect(imageModelPreset('nano-banana').resolutionNote).toBe('这个型号只出 1K')
    expect(buildImageRequestParameters({ model: 'nano-banana-pro', prompt: '海边', size: '1280x720', quality: 'high' })).toEqual({ model: 'nano-banana-pro', prompt: '海边', n: 1, size: '1280x720' })
  })

  it('lets the service size the other vendors\' image models and sends neither size nor quality', () => {
    for (const model of imagesApiModels) {
      expect(imageModelPreset(model), model).toEqual({
        id: model, label: model, sizes: [], supportsSize: false, supportsQuality: false, resolutions: ['1K'],
        resolutionNote: '这个型号的输出尺寸由服务决定', supportsEdits: false,
      })
      expect(buildImageRequestParameters({ model, prompt: '海边', size: '1024x1024', quality: 'high' }), model).toEqual({ model, prompt: '海边', n: 1 })
      expect(inspectImageResolutionSelection({ model, size: '1024x1024' }, desktop), model).toMatchObject({ providerSized: true, supported: true })
    }
  })

  it('follows the template of the family for newer GPT Image, Grok and Jimeng names', () => {
    expect(imageModelPreset('gpt-image-3')).toMatchObject({ sizes: imageModelPreset('gpt-image-2').sizes, supportsSize: true, supportsQuality: true, supportsEdits: true })
    expect(imageModelPreset('gpt-image-3', desktop).resolutions).toEqual(['1K', '2K', '4K'])
    expect(imageModelPreset('grok-imagine-image-3')).toMatchObject({ label: 'grok-imagine-image-3', supportsSize: false, supportsQuality: false, supportsEdits: true })
    expect(imageModelPreset('jimeng_high_aes_general_v30')).toMatchObject({ supportsSize: false, supportsEdits: false, ephemeralUrl: true })
    for (const model of ['grok-imagine-image-3', 'jimeng_high_aes_general_v30']) {
      expect(buildImageRequestParameters({ model, prompt: '海边', size: '1280x720', quality: 'high' }), model).toEqual({ model, prompt: '海边', n: 1 })
    }
  })

  it('lets a desktop run Nano Banana at 1K and stops an edit node before a paid request', () => {
    expect(imageModelPreset('nano-banana-2', desktop).resolutions).toEqual(['1K'])
    expect(preflight('image-generate', 'nano-banana-2', '1280x720')).toMatchObject({ canStart: true, blockedCount: 0 })
    expect(preflight('image-generate', 'flux-2-pro', '1024x1024')).toMatchObject({ canStart: true, blockedCount: 0 })
    expect(validateImageModelOptions({ model: 'nano-banana-2', operation: 'edit', size: '1280x720', referenceImageCount: 1 }, desktop)).toContain('模型「Nano Banana 2」不支持图片编辑')
    // 改图节点的型号下拉只给能改图的（WorkflowNodes 按 supportsEdits 过滤）。
    expect(availableImageModelPresets(availableModelsForKind('image', xmImageGroup), true).filter((preset) => preset.supportsEdits).map((preset) => preset.id))
      .toEqual(['gpt-image-2.6-flare', 'gpt-image-2.5-flare', 'gpt-image-2', 'gpt-image-2.6-sunburst', 'gpt-image-2.5-sunburst'])
  })

  it('still lists every other name for a source that declares an image purpose, after the recognised ones', () => {
    // 网页的来源声明用途，没认出来的名字照旧能选，只是排在认出来的后面。
    expect(availableImageModelPresets(['custom-image', 'nano-banana-2', 'gpt-image-2'], true).map((preset) => preset.id)).toEqual(['gpt-image-2', 'nano-banana-2', 'custom-image'])
    expect(recognisedImageModel('custom-image')).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { KNOWN_IMAGE_MODEL_IDS, resolveAiModelCapability } from './ai-chat-protocol'
import { desktopCanvasCapabilities, maximumCanvasPromptPresetNameLength } from './canvas-contract'
import { createCanvasNodeExecutors } from './canvas-node-executors'
import { parseCanvasPromptPresetInput, parseCanvasStartRunInput, parseCanvasVideoGenerateInput } from './canvas-request-parser'

// The capabilities answer is a hand-written literal the canvas kernel trusts
// to decide what to offer. These pin it to the code that actually does the
// work, so a new executor or image model cannot leave it describing a host
// that no longer exists.
describe('desktop canvas capabilities', () => {
  it('lists exactly the node kinds that have a working executor', () => {
    // bootstrap/ai-services.ts always hands the executors a frame extractor
    // and the image-tool processing; without the first frame-extract has an
    // entry only to fail it with a reason, without the second no image tool
    // has an entry at all.
    const frames = { assertDecodableVideo: async () => undefined, waitForFrame: async () => { throw new Error('unused') } }
    const imageTools = { assertSources: async () => undefined, waitForImages: async () => { throw new Error('unused') } }
    const executors = createCanvasNodeExecutors({ imageService: { generate: async () => [], cancel: () => ({ canceled: false, mayStillComplete: false }) }, frames, imageTools })
    expect([...desktopCanvasCapabilities.executableNodeKinds].sort()).toEqual(Object.keys(executors).sort())
  })

  it('switches on the balance chip, the run quote, masked edits, text nodes, page-drawn pictures, frame extraction, image tools, reference orders and scene tasks and off every feature the desktop does not have yet', () => {
    // 画布完善第 2b 条: the chip reads canvas-host:get-account-summary, the quote
    // canvas-host:get-price-snapshot. 第 5 条: an image-edit node's mask rides
    // canvas-host:start-run and goes out as the edits request's mask PNG
    // (canvas-image-mask.ts). 第 6 条: text-generate nodes run through the chat
    // service (canvas-node-executors.ts). 第 7 条第一步: the mask editor's PNG
    // goes back through canvas-host:import-asset-bytes (canvas-byte-upload.ts).
    // 第 7 条第二步: the kernel decodes the frame a frame-extract node waits on
    // and hands it back through canvas-host:complete-run-preparation
    // (canvas-run-preparations.ts). 第 7 条第三步: the kernel makes the
    // pictures a crop, collage, tile or layer node waits on and hands them back
    // the same way. 第 8 条第一步: picture roles and video reference orders
    // reorder what the node already receives (canvas-reference-order.ts). 第二
    // 步: the four scene tasks write the prompt from fixed options in the main
    // process (canvas-scene-tasks.ts). The rest stays off.
    const { accountSummary, quote, imageEditMask, textGenerate, byteUpload, frameExtract, imageTools, referenceOrder, scenarioTemplates, ...rest } = desktopCanvasCapabilities.features
    expect(accountSummary).toBe(true)
    expect(quote).toBe(true)
    expect(imageEditMask).toBe(true)
    expect(textGenerate).toBe(true)
    expect(byteUpload).toBe(true)
    expect(frameExtract).toBe(true)
    expect(imageTools).toBe(true)
    expect(referenceOrder).toBe(true)
    expect(scenarioTemplates).toBe(true)
    expect(Object.values(rest).every((enabled) => enabled === false)).toBe(true)
    // Image nodes send 2-4 independent one-image requests (canvas-run-engine.ts).
    expect(desktopCanvasCapabilities.imageCandidates.maximum).toBe(4)
    expect(desktopCanvasCapabilities.videoCandidates.maximum).toBe(1)
  })

  it('reports the image resolutions the main process accepts for each model', () => {
    const available = KNOWN_IMAGE_MODEL_IDS.filter((model) => resolveAiModelCapability(model).available)
    expect(Object.keys(desktopCanvasCapabilities.imageResolutions.byModel).sort()).toEqual([...available].sort())
    for (const model of available) {
      const capability = resolveAiModelCapability(model)
      if (capability.kind !== 'image') throw new Error(`${model} is not an image model`)
      expect(desktopCanvasCapabilities.imageResolutions.byModel[model], model).toEqual(capability.resolutions)
    }
    const otherGptImage = resolveAiModelCapability('gpt-image-3')
    if (otherGptImage.kind !== 'image') throw new Error('gpt-image-3 is not an image model')
    expect(desktopCanvasCapabilities.imageResolutions.otherGptImage).toEqual(otherGptImage.resolutions)
    expect(resolveAiModelCapability('gpt-image-1.5-mini').available).toBe(false)
  })

  it('reports the video settings the run parser and the video parser accept', () => {
    const { video } = desktopCanvasCapabilities
    function videoRun(data: Record<string, unknown>) {
      return parseCanvasStartRunInput({
        graph: { nodes: [{ id: 'video', kind: 'video-generate', definitionVersion: 1, data: { prompt: 'p', model: 'minimax-h3-base', ...data } }], edges: [] },
        scope: { kind: 'all' },
      })
    }
    for (const seconds of [video.seconds.minimum, video.seconds.maximum]) expect(() => videoRun({ seconds: String(seconds) })).not.toThrow()
    for (const seconds of [video.seconds.minimum - 1, video.seconds.maximum + 1]) expect(() => videoRun({ seconds: String(seconds) })).toThrow()
    for (const videoResolution of video.miniMaxResolutions) expect(() => videoRun({ videoResolution })).not.toThrow()
    expect(() => videoRun({ videoResolution: '1080p' })).toThrow('分辨率不受支持')
    for (const videoAspectRatio of video.miniMaxAspectRatios) expect(() => videoRun({ videoAspectRatio })).not.toThrow()
    expect(() => videoRun({ videoAspectRatio: '3:2' })).toThrow('视频比例不受支持')
    for (const videoProtocol of ['xai-native', 'ark-seedance']) {
      expect(video.protocols).not.toContain(videoProtocol)
      expect(videoRun({ videoProtocol }).graph.nodes[0].desktopUnsupported).toContain('这个视频接口')
    }
    expect(videoRun({ videoProtocol: video.protocols[0] }).graph.nodes[0]).not.toHaveProperty('desktopUnsupported')

    const base = { requestId: 'run-1', group: 'g', model: 'grok-imagine-video', prompt: 'p', seconds: '5' }
    for (const dimension of video.dimensions) {
      const [width, height] = dimension.split('x').map(Number)
      expect(() => parseCanvasVideoGenerateInput({ ...base, width, height }), dimension).not.toThrow()
    }
    expect(() => parseCanvasVideoGenerateInput({ ...base, width: 1920, height: 1080 })).toThrow('比例不受支持')
  })

  it('reports the prompt preset name limit the parser enforces', () => {
    expect(desktopCanvasCapabilities.promptPresetNameMaxLength).toBe(maximumCanvasPromptPresetNameLength)
    const limit = desktopCanvasCapabilities.promptPresetNameMaxLength
    expect(() => parseCanvasPromptPresetInput({ name: '名'.repeat(limit), prompt: 'p' })).not.toThrow()
    expect(() => parseCanvasPromptPresetInput({ name: '名'.repeat(limit + 1), prompt: 'p' })).toThrow('名称格式错误')
  })

  it('carries nothing tied to an account or a secret', () => {
    expect(JSON.stringify(desktopCanvasCapabilities)).not.toMatch(/apiKey|token|Authorization|cookie|password|https?:|user-\d/i)
  })
})

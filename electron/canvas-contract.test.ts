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
    const executors = createCanvasNodeExecutors({ imageService: { generate: async () => [], cancel: () => ({ canceled: false, mayStillComplete: false }) } })
    // frame-extract has an entry only to fail it with a reason.
    const working = Object.keys(executors).filter((kind) => kind !== 'frame-extract').sort()
    expect([...desktopCanvasCapabilities.executableNodeKinds].sort()).toEqual(working)
  })

  it('switches off every feature the desktop does not have yet', () => {
    expect(Object.values(desktopCanvasCapabilities.features).every((enabled) => enabled === false)).toBe(true)
    expect(desktopCanvasCapabilities.imageCandidates.maximum).toBe(1)
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

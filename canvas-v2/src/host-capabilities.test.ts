import { describe, expect, it, vi } from 'vitest'
import {
  KERNEL_CONTRACT_VERSION,
  canvasCapabilities,
  canvasImageModelResolutions,
  canvasNodeKindAvailable,
  resolveCanvasCapabilities,
  v2EquivalentCapabilities,
  type CanvasHostCapabilities,
} from './host-capabilities'

function declaration(overrides: Partial<CanvasHostCapabilities> = {}): CanvasHostCapabilities {
  return {
    contractVersion: 1,
    host: 'desktop',
    executableNodeKinds: ['prompt', 'image-generate', 'video-generate'],
    features: {
      quote: false, accountSummary: false, imageEditMask: true, textGenerate: false, textWebSearch: false, imageTools: false,
      frameExtract: false, scenarioTemplates: false, routerStrategy: false, generateAudio: false, referenceOrder: false,
      cloud: false, agentExecution: false, byteUpload: false, promptPresetGroups: false,
    },
    imageCandidates: { maximum: 2 },
    videoCandidates: { maximum: 1 },
    promptPresetNameMaxLength: 160,
    imageResolutions: { byModel: { 'gemini-3.1-flash-image': ['1K', '2K', '4K'], 'gpt-image-1': ['1K'] }, otherGptImage: ['1K', '2K'] },
    video: {
      siteIds: ['solov'], protocols: ['relay-videos'], seconds: { minimum: 1, maximum: 15 },
      dimensions: ['1280x720'], miniMaxResolutions: ['480p', '720p'], miniMaxAspectRatios: ['16:9'],
    },
    ...overrides,
  }
}

describe('canvas host capabilities', () => {
  it('falls back to the v2-equivalent set when the host declares nothing', () => {
    expect(resolveCanvasCapabilities(undefined)).toBe(v2EquivalentCapabilities)
    expect(canvasCapabilities(undefined)).toBe(v2EquivalentCapabilities)
    expect(canvasCapabilities({})).toBe(v2EquivalentCapabilities)
    const profile = v2EquivalentCapabilities
    expect(profile.contractVersion).toBe(0)
    expect(Object.values(profile.features).every((enabled) => enabled === false)).toBe(true)
    expect(profile.imageCandidates.maximum).toBe(1)
    expect(profile.videoCandidates.maximum).toBe(1)
    expect(profile.promptPresets).toEqual({ nameMaxLength: 100 })
    expect(profile.project).toEqual({ nodeDataFields: 'v2', settingsArrayMaximum: 256, noteText: { maximumLength: 10_000, plainTextOnly: true } })
    expect(profile.runNodeDataFields).toBe('v2')
    expect(profile.createProjectWithContent).toBe(false)
    expect([...profile.video.protocols]).toEqual(['relay-videos'])
    expect(profile.video.siteIds).toBeUndefined()
  })

  it('offers only the node kinds the v2 editor ran', () => {
    expect([...v2EquivalentCapabilities.executableNodeKinds].sort()).toEqual([
      'audio-input', 'drama-bible', 'drama-character', 'drama-parse', 'drama-prop', 'drama-scene', 'drama-script', 'drama-shot',
      'gallery', 'group', 'image', 'image-edit', 'image-generate', 'image-input', 'note', 'output', 'prompt', 'router', 'text',
      'video', 'video-generate', 'video-input',
    ])
    for (const kind of ['text-generate', 'frame-extract', 'image-crop', 'image-collage', 'image-grid-split', 'image-tile', 'image-layer', 'image-compare', 'image-panorama']) {
      expect(canvasNodeKindAvailable(kind, v2EquivalentCapabilities), kind).toBe(false)
    }
  })

  it('keeps structural nodes available whatever the host lists', () => {
    const profile = resolveCanvasCapabilities(declaration({ executableNodeKinds: ['prompt'] }))
    expect(canvasNodeKindAvailable('group', profile)).toBe(true)
    expect(canvasNodeKindAvailable('note', profile)).toBe(true)
    expect(canvasNodeKindAvailable('prompt', profile)).toBe(true)
    expect(canvasNodeKindAvailable('image-generate', profile)).toBe(false)
    expect(canvasNodeKindAvailable('unknown', profile)).toBe(false)
  })

  it('does not offer a feature node the host lists but switches off', () => {
    const kinds = ['prompt', 'text-generate', 'frame-extract', 'image-crop', 'image-panorama']
    const off = resolveCanvasCapabilities(declaration({ executableNodeKinds: kinds }))
    for (const kind of ['text-generate', 'frame-extract', 'image-crop', 'image-panorama']) expect(canvasNodeKindAvailable(kind, off), kind).toBe(false)
    expect(canvasNodeKindAvailable('prompt', off)).toBe(true)
    const { features } = declaration()
    const on = resolveCanvasCapabilities(declaration({ executableNodeKinds: kinds, features: { ...features, textGenerate: true, frameExtract: true, imageTools: true } }))
    for (const kind of kinds) expect(canvasNodeKindAvailable(kind, on), kind).toBe(true)
  })

  it('reads a version-1 declaration as the kernel formats with the declared switches', () => {
    const profile = resolveCanvasCapabilities(declaration())
    expect(profile.contractVersion).toBe(1)
    expect(profile.host).toBe('desktop')
    expect(profile.features.imageEditMask).toBe(true)
    expect(profile.features.textGenerate).toBe(false)
    expect(profile.features.fileDownload).toBe(false)
    expect(profile.features.clipboardRead).toBe(false)
    expect(profile.imageCandidates.maximum).toBe(2)
    expect(profile.promptPresets).toEqual({ nameMaxLength: 160 })
    expect(profile.project).toEqual({ nodeDataFields: 'kernel', settingsArrayMaximum: 4_096, noteText: { maximumLength: 100_000, plainTextOnly: false } })
    expect(profile.runNodeDataFields).toBe('kernel')
    expect(profile.createProjectWithContent).toBe(true)
    expect([...profile.video.siteIds ?? []]).toEqual(['solov'])
    expect(Object.isFrozen(profile)).toBe(true)
    expect(Object.isFrozen(profile.features)).toBe(true)
  })

  it('reads a newer host as the version this kernel speaks', () => {
    expect(resolveCanvasCapabilities(declaration({ contractVersion: KERNEL_CONTRACT_VERSION + 3 })).contractVersion).toBe(KERNEL_CONTRACT_VERSION)
  })

  it('treats an unclear declaration as no declaration', () => {
    const bad: unknown[] = [
      null, [], 'desktop', { ...declaration(), contractVersion: 0 }, { ...declaration(), contractVersion: 1.5 }, { ...declaration(), contractVersion: '1' },
      { ...declaration(), host: 'sites' }, { ...declaration(), executableNodeKinds: 'prompt' }, { ...declaration(), executableNodeKinds: [1] },
      { ...declaration(), features: [] }, { ...declaration(), imageCandidates: { maximum: 0 } }, { ...declaration(), promptPresetNameMaxLength: -1 },
      { ...declaration(), imageResolutions: { byModel: { 'gpt-image-2': ['8K'] }, otherGptImage: ['1K'] } },
      { ...declaration(), imageResolutions: { byModel: {}, otherGptImage: '1K' } },
      { ...declaration(), video: { ...declaration().video, seconds: { minimum: 10, maximum: 5 } } },
      { ...declaration(), video: { ...declaration().video, dimensions: ['wide'] } },
      { ...declaration(), video: { ...declaration().video, siteIds: 'solov' } },
    ]
    for (const value of bad) expect(resolveCanvasCapabilities(value), JSON.stringify(value)).toBe(v2EquivalentCapabilities)
  })

  it('turns off switches a host leaves out and ignores ones this kernel does not know', () => {
    const { features } = declaration()
    const partial = Object.fromEntries(Object.entries(features).filter(([name]) => name !== 'imageEditMask'))
    const profile = resolveCanvasCapabilities({ ...declaration(), features: { ...partial, somethingNew: true } })
    expect(profile.features.imageEditMask).toBe(false)
    expect(profile.features).not.toHaveProperty('somethingNew')
  })

  it('never offers more candidates or a longer preset name than the kernel builds', () => {
    const profile = resolveCanvasCapabilities(declaration({ imageCandidates: { maximum: 9 }, videoCandidates: { maximum: 9 }, promptPresetNameMaxLength: 500 }))
    expect(profile.imageCandidates.maximum).toBe(4)
    expect(profile.videoCandidates.maximum).toBe(4)
    expect(profile.promptPresets.nameMaxLength).toBe(160)
  })

  it('looks up image resolutions by model, then gpt-image, then everything else', () => {
    const profile = resolveCanvasCapabilities(declaration())
    expect(canvasImageModelResolutions('gemini-3.1-flash-image', profile)).toEqual(['1K', '2K', '4K'])
    expect(canvasImageModelResolutions(' GPT-IMAGE-1 ', profile)).toEqual(['1K'])
    expect(canvasImageModelResolutions('gpt-image-3', profile)).toEqual(['1K', '2K'])
    expect(canvasImageModelResolutions('gpt-image-1.5', profile)).toEqual(['1K'])
    expect(canvasImageModelResolutions('flux-pro', profile)).toEqual(['1K'])
    const generous = resolveCanvasCapabilities(declaration({ imageResolutions: { byModel: {}, otherGptImage: ['1K'], otherModels: ['4K', '1K'] } }))
    expect(canvasImageModelResolutions('flux-pro', generous)).toEqual(['1K', '4K'])
  })

  it('keeps the v2 model table for hosts that declare nothing', () => {
    expect(canvasImageModelResolutions('gemini-3.1-flash-image', v2EquivalentCapabilities)).toEqual(['1K', '2K', '4K'])
    expect(canvasImageModelResolutions('gpt-image-2', v2EquivalentCapabilities)).toEqual(['1K', '2K', '4K'])
    expect(canvasImageModelResolutions('jimeng_high_aes_general_v21_L', v2EquivalentCapabilities)).toEqual(['1K'])
    expect(canvasImageModelResolutions('grok-imagine-image', v2EquivalentCapabilities)).toEqual(['1K'])
    expect(canvasImageModelResolutions('some-new-model', v2EquivalentCapabilities)).toEqual(['1K', '2K', '4K'])
  })

  it('asks a bridge once and keeps its answer', () => {
    const capabilities = vi.fn(() => declaration())
    const bridge = { capabilities }
    const first = canvasCapabilities(bridge)
    expect(canvasCapabilities(bridge)).toBe(first)
    expect(capabilities).toHaveBeenCalledTimes(1)
    expect(first.contractVersion).toBe(1)
  })

  it('treats a capabilities() that throws as no declaration', () => {
    expect(canvasCapabilities({ capabilities: () => { throw new Error('boom') } })).toBe(v2EquivalentCapabilities)
  })
})

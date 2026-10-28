// 宿主能力（#4）：宿主用 capabilities() 声明它能执行什么、存得下什么，内核按声明显示入口、写数据。
// 宿主没有 capabilities()、声明的形状不对，或契约版本认不出来时，一律按「v2 等价功能集」：桌面换内核以前
// 那个 v2 编辑器能做的事、桌面 000f913 的校验器收得下的数据，新功能全藏，不弹任何「请更新」提示。
// 声明只决定内核显示什么、发什么；一件事最后能不能做，仍由宿主执行前自己校验（桌面在付费前拒绝）。
// 字段的含义和各版本的差别写在 canvas-kernel/contract/README.md。

import { builtinNodeRegistry } from './domain/builtin-node-definitions'
import { canvasHostKind, isCanvasHostKind, type CanvasHostKind } from './host-kind'

/** The contract this kernel speaks. Desktop #1425 (D-PR0) declares version 1. */
export const KERNEL_CONTRACT_VERSION = 1

export type CanvasCapabilityImageResolution = '1K' | '2K' | '4K'

/** Switches for entries a host may lack. A switch a host leaves out is off. */
export interface CanvasHostFeatures {
  quote: boolean
  accountSummary: boolean
  imageEditMask: boolean
  textGenerate: boolean
  textWebSearch: boolean
  imageTools: boolean
  frameExtract: boolean
  scenarioTemplates: boolean
  routerStrategy: boolean
  generateAudio: boolean
  referenceOrder: boolean
  cloud: boolean
  agentExecution: boolean
  byteUpload: boolean
  promptPresetGroups: boolean
  /** Added after desktop v1: the page may download files itself. The desktop canvas window blocks that. */
  fileDownload?: boolean
  /** Added after desktop v1: the menu paste reads the system clipboard. */
  clipboardRead?: boolean
}

export type CanvasHostFeature = keyof CanvasHostFeatures

/**
 * What a host declares. The desktop's literal (electron/canvas-contract.ts at
 * 14c2c76) is assignable to it as written; the optional members are kernel
 * additions a version-1 desktop does not send.
 */
export interface CanvasHostCapabilities {
  contractVersion: number
  host: CanvasHostKind
  executableNodeKinds: readonly string[]
  features: CanvasHostFeatures
  imageCandidates: { maximum: number }
  videoCandidates: { maximum: number }
  promptPresetNameMaxLength: number
  imageResolutions: {
    byModel: Readonly<Record<string, readonly CanvasCapabilityImageResolution[]>>
    /** Any other gpt-image-* model the account lists, except gpt-image-1.5. */
    otherGptImage: readonly CanvasCapabilityImageResolution[]
    /** Every other model. Left out, it is 1K: the host sends no resolution at all. */
    otherModels?: readonly CanvasCapabilityImageResolution[]
    /**
     * Added after desktop v1: the host sends the image request the kernel's
     * own builder (runtime/image-request-parameters.ts) makes, so the pixel
     * size the kernel works out is the size sent. Left out, the host works
     * out 2K and 4K sizes itself and the kernel names none.
     */
    kernelRequestSizes?: boolean
  }
  video: {
    /** Account sites with video. Left out, or while the host has not said which site the account is on, video does not depend on the site. */
    siteIds?: readonly string[]
    protocols: readonly string[]
    seconds: { minimum: number; maximum: number }
    dimensions: readonly string[]
    miniMaxResolutions: readonly string[]
    miniMaxAspectRatios: readonly string[]
  }
}

/** The kernel's resolved view: a declaration checked against what this kernel understands, or the v2-equivalent set. */
export interface CanvasCapabilityProfile {
  /** 0 when nothing usable was declared and the v2-equivalent set applies. */
  contractVersion: number
  host: CanvasHostKind
  executableNodeKinds: ReadonlySet<string>
  features: Readonly<Required<CanvasHostFeatures>>
  imageCandidates: { maximum: number }
  videoCandidates: { maximum: number }
  /** Without features.promptPresetGroups, requests carry only name, prompt and tags (and id on update). */
  promptPresets: { nameMaxLength: number }
  imageResolutions: {
    byModel: ReadonlyMap<string, readonly CanvasCapabilityImageResolution[]>
    otherGptImage: readonly CanvasCapabilityImageResolution[]
    otherModels: readonly CanvasCapabilityImageResolution[]
    kernelRequestSizes: boolean
  }
  video: {
    siteIds?: ReadonlySet<string>
    protocols: ReadonlySet<string>
    seconds: { minimum: number; maximum: number }
    dimensions: readonly string[]
    miniMaxResolutions: ReadonlySet<string>
    miniMaxAspectRatios: ReadonlySet<string>
  }
  /** What the host's project store keeps. v2: the eleven node data keys desktop 000f913 accepts. */
  project: {
    nodeDataFields: 'v2' | 'kernel'
    settingsArrayMaximum: number
    noteText: { maximumLength: number; plainTextOnly: boolean }
  }
  /** What the host's run parser accepts. v2: the twelve node data keys desktop 000f913 accepts. */
  runNodeDataFields: 'v2' | 'kernel'
  /** createProject(name, content, options) keeps the content; v2 hosts drop it. */
  createProjectWithContent: boolean
}

const featureNames: readonly CanvasHostFeature[] = [
  'quote', 'accountSummary', 'imageEditMask', 'textGenerate', 'textWebSearch', 'imageTools', 'frameExtract',
  'scenarioTemplates', 'routerStrategy', 'generateAudio', 'referenceOrder', 'cloud', 'agentExecution', 'byteUpload',
  'promptPresetGroups', 'fileDownload', 'clipboardRead',
]

const imageResolutionValues: readonly CanvasCapabilityImageResolution[] = ['1K', '2K', '4K']
const kernelPromptPresetNameMaxLength = 160
const kernelCandidateMaximum = 4

// Desktop 000f913 is the last desktop with the v2 editor; these mirror what
// its parsers accept and what that editor offered (canvas-v2/src/models.ts).
const v2ExecutableNodeKinds = [
  'text', 'prompt', 'note', 'image', 'image-generate', 'image-edit', 'video', 'video-generate',
  'image-input', 'video-input', 'audio-input', 'router', 'gallery', 'output', 'group',
  'drama-bible', 'drama-script', 'drama-parse', 'drama-shot', 'drama-character', 'drama-scene', 'drama-prop',
]

function freezeProfile(profile: CanvasCapabilityProfile): CanvasCapabilityProfile {
  Object.freeze(profile.features)
  Object.freeze(profile.imageCandidates)
  Object.freeze(profile.videoCandidates)
  Object.freeze(profile.promptPresets)
  Object.freeze(profile.imageResolutions)
  Object.freeze(profile.video.seconds)
  Object.freeze(profile.video)
  Object.freeze(profile.project.noteText)
  Object.freeze(profile.project)
  return Object.freeze(profile)
}

function allFeatures(enabled: boolean): Required<CanvasHostFeatures> {
  return Object.fromEntries(featureNames.map((name) => [name, enabled])) as unknown as Required<CanvasHostFeatures>
}

/** The set a host gets when it declares nothing usable. */
export const v2EquivalentCapabilities: CanvasCapabilityProfile = freezeProfile({
  contractVersion: 0,
  host: canvasHostKind,
  executableNodeKinds: new Set(v2ExecutableNodeKinds),
  features: allFeatures(false),
  imageCandidates: { maximum: 1 },
  videoCandidates: { maximum: 1 },
  promptPresets: { nameMaxLength: 100 },
  imageResolutions: {
    byModel: new Map([
      ['gpt-image-2', imageResolutionValues],
      ['gemini-3.1-flash-image', imageResolutionValues],
      ['gpt-image-1', ['1K']],
      ['jimeng_high_aes_general_v21_L', ['1K']],
      ['grok-imagine-image', ['1K']],
      ['grok-imagine-image-2.0', ['1K']],
      ['grok-imagine-image-quality', ['1K']],
    ]),
    // v2 treats a model it does not know as GPT Image 2 and lets the host refuse.
    otherGptImage: imageResolutionValues,
    otherModels: imageResolutionValues,
    // The v2-era desktop scales 2K and 4K in its main process, to its own sizes.
    kernelRequestSizes: false,
  },
  video: {
    // The v2 editor had no site switch; the host itself refused video where
    // it had none.
    protocols: new Set(['relay-videos']),
    seconds: { minimum: 1, maximum: 15 },
    dimensions: ['1280x720', '720x1280', '1024x1024', '1024x768', '768x1024'],
    miniMaxResolutions: new Set(['480p', '720p']),
    miniMaxAspectRatios: new Set(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '9:21', '4:5', '5:4']),
  },
  project: { nodeDataFields: 'v2', settingsArrayMaximum: 256, noteText: { maximumLength: 10_000, plainTextOnly: true } },
  runNodeDataFields: 'v2',
  createProjectWithContent: false,
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : undefined
}

function stringList(value: unknown, maximumLength = 128): string[] | undefined {
  if (!Array.isArray(value) || value.length > 512 || !value.every((entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= maximumLength)) return undefined
  return [...new Set(value as string[])]
}

function resolutionList(value: unknown): CanvasCapabilityImageResolution[] | undefined {
  const list = stringList(value, 2)
  if (!list || !list.every((entry): entry is CanvasCapabilityImageResolution => (imageResolutionValues as readonly string[]).includes(entry))) return undefined
  return imageResolutionValues.filter((resolution) => list.includes(resolution))
}

function candidateMaximum(value: unknown): number | undefined {
  return isRecord(value) ? boundedInteger(value.maximum, 1, Number.MAX_SAFE_INTEGER) : undefined
}

/**
 * Reads a declaration into a profile. Anything that does not have the shape
 * of a version this kernel knows yields the v2-equivalent set rather than a
 * guess: a host that says something unclear gets the conservative answer.
 */
export function resolveCanvasCapabilities(declared: unknown): CanvasCapabilityProfile {
  if (!isRecord(declared)) return v2EquivalentCapabilities
  const declaredVersion = boundedInteger(declared.contractVersion, 1, Number.MAX_SAFE_INTEGER)
  if (declaredVersion === undefined || !isCanvasHostKind(declared.host)) return v2EquivalentCapabilities
  // A newer host still describes itself in fields this kernel reads the
  // version-1 way; an older one is read by its own version.
  const contractVersion = Math.min(declaredVersion, KERNEL_CONTRACT_VERSION)
  const executableNodeKinds = stringList(declared.executableNodeKinds, 64)
  const features = declared.features
  const imageCandidates = candidateMaximum(declared.imageCandidates)
  const videoCandidates = candidateMaximum(declared.videoCandidates)
  const nameMaxLength = boundedInteger(declared.promptPresetNameMaxLength, 1, Number.MAX_SAFE_INTEGER)
  const resolutions = declared.imageResolutions
  const video = declared.video
  if (!executableNodeKinds || !isRecord(features) || imageCandidates === undefined || videoCandidates === undefined || nameMaxLength === undefined
    || !isRecord(resolutions) || !isRecord(resolutions.byModel) || !isRecord(video) || !isRecord(video.seconds)) return v2EquivalentCapabilities
  const byModel = new Map<string, readonly CanvasCapabilityImageResolution[]>()
  for (const [model, list] of Object.entries(resolutions.byModel)) {
    const parsed = resolutionList(list)
    if (!model || model.length > 200 || !parsed) return v2EquivalentCapabilities
    byModel.set(model, parsed)
  }
  const otherGptImage = resolutionList(resolutions.otherGptImage)
  const otherModels = resolutions.otherModels === undefined ? ['1K' as const] : resolutionList(resolutions.otherModels)
  const siteIds = video.siteIds === undefined ? undefined : stringList(video.siteIds, 64)
  const protocols = stringList(video.protocols, 64)
  const minimumSeconds = boundedInteger(video.seconds.minimum, 1, 3_600)
  const maximumSeconds = boundedInteger(video.seconds.maximum, 1, 3_600)
  const dimensions = stringList(video.dimensions, 16)
  const miniMaxResolutions = stringList(video.miniMaxResolutions, 16)
  const miniMaxAspectRatios = stringList(video.miniMaxAspectRatios, 16)
  if (!otherGptImage || !otherModels || (video.siteIds !== undefined && !siteIds) || !protocols || minimumSeconds === undefined || maximumSeconds === undefined
    || minimumSeconds > maximumSeconds || !dimensions || !dimensions.every((entry) => /^\d{2,5}x\d{2,5}$/.test(entry)) || !miniMaxResolutions || !miniMaxAspectRatios) {
    return v2EquivalentCapabilities
  }
  return freezeProfile({
    contractVersion,
    host: declared.host,
    executableNodeKinds: new Set(executableNodeKinds),
    features: Object.fromEntries(featureNames.map((name) => [name, features[name] === true])) as unknown as Required<CanvasHostFeatures>,
    // The kernel never offers more than it can build, whatever the host says.
    imageCandidates: { maximum: Math.min(imageCandidates, kernelCandidateMaximum) },
    videoCandidates: { maximum: Math.min(videoCandidates, kernelCandidateMaximum) },
    promptPresets: { nameMaxLength: Math.min(nameMaxLength, kernelPromptPresetNameMaxLength) },
    imageResolutions: { byModel, otherGptImage, otherModels, kernelRequestSizes: resolutions.kernelRequestSizes === true },
    video: {
      ...(siteIds ? { siteIds: new Set(siteIds) } : {}),
      protocols: new Set(protocols),
      seconds: { minimum: minimumSeconds, maximum: maximumSeconds },
      dimensions,
      miniMaxResolutions: new Set(miniMaxResolutions),
      miniMaxAspectRatios: new Set(miniMaxAspectRatios),
    },
    // Version 1 is the desktop that accepts the kernel's own project and run
    // formats (#1425): every node data key, 4 096-item setting arrays, note
    // text as text, and content passed to createProject.
    project: { nodeDataFields: 'kernel', settingsArrayMaximum: 4_096, noteText: { maximumLength: 100_000, plainTextOnly: false } },
    runNodeDataFields: 'kernel',
    createProjectWithContent: true,
  })
}

interface CapabilitiesSource {
  capabilities?(): unknown
}

const resolved = new WeakMap<object, CanvasCapabilityProfile>()

/**
 * The profile for a host bridge, read once per bridge: a host's answer is
 * static. A capabilities() that throws counts as no declaration.
 */
export function canvasCapabilities(bridge: CapabilitiesSource | undefined = typeof window === 'undefined' ? undefined : window.xingmangCanvasHost): CanvasCapabilityProfile {
  if (!bridge) return v2EquivalentCapabilities
  const cached = resolved.get(bridge)
  if (cached) return cached
  let declared: unknown
  try {
    declared = typeof bridge.capabilities === 'function' ? bridge.capabilities() : undefined
  } catch {
    declared = undefined
  }
  const profile = resolveCanvasCapabilities(declared)
  resolved.set(bridge, profile)
  return profile
}

export function canvasFeatureEnabled(feature: CanvasHostFeature, profile: CanvasCapabilityProfile = canvasCapabilities()): boolean {
  return profile.features[feature]
}

// Node kinds that are one switch's whole feature. A host that lists the kind
// but turns the switch off still does not get it: either half saying no is no.
const featureNodeKinds: Readonly<Record<string, CanvasHostFeature>> = {
  'text-generate': 'textGenerate',
  'frame-extract': 'frameExtract',
  'image-crop': 'imageTools',
  'image-collage': 'imageTools',
  'image-grid-split': 'imageTools',
  'image-tile': 'imageTools',
  'image-layer': 'imageTools',
  'image-compare': 'imageTools',
  'image-panorama': 'imageTools',
}

/**
 * Whether the editor may offer a node kind. Structural nodes (group, note)
 * never reach a host, so only executable kinds depend on the declaration.
 */
export function canvasNodeKindAvailable(kind: string, profile: CanvasCapabilityProfile = canvasCapabilities()): boolean {
  const definition = builtinNodeRegistry.resolve(kind)
  if (!definition || kind === 'unknown') return false
  if (!definition.executable) return true
  const feature = Object.hasOwn(featureNodeKinds, kind) ? featureNodeKinds[kind] : undefined
  return profile.executableNodeKinds.has(kind) && (feature === undefined || profile.features[feature])
}

/** The resolutions the host accepts for one image model, in 1K, 2K, 4K order. */
export function canvasImageModelResolutions(model: string, profile: CanvasCapabilityProfile = canvasCapabilities()): readonly CanvasCapabilityImageResolution[] {
  const name = model.trim()
  const listed = profile.imageResolutions.byModel.get(name)
    ?? [...profile.imageResolutions.byModel].find(([id]) => id.toLowerCase() === name.toLowerCase())?.[1]
  if (listed) return listed
  const lower = name.toLowerCase()
  if (lower.startsWith('gpt-image-') && !lower.startsWith('gpt-image-1.5')) return profile.imageResolutions.otherGptImage
  return profile.imageResolutions.otherModels
}

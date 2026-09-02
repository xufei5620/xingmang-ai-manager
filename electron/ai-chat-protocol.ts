export const AI_CHAT_ENDPOINTS = {
  chatCompletions: '/v1/chat/completions',
  imageGenerations: '/v1/images/generations',
  imageEdits: '/v1/images/edits',
  videos: '/v1/videos',
} as const

export const AI_CHAT_LIMITS = {
  modelLength: 128,
  groupLength: 128,
  messageCount: 100,
  messageLength: 40_000,
  totalMessageLength: 120_000,
  promptLength: 40_000,
  // An 8 MB owned image expands to roughly 10.7 MB after base64 encoding.
  videoImageLength: 12 * 1024 * 1024,
  maxTokens: 131_072,
} as const

export type AiChatGroup = {
  id: string
  label: string
  ratio?: number
}

export type AiChatRole = 'system' | 'user' | 'assistant'

export type AiChatMessage = {
  role: AiChatRole
  content: string
}

export type AiChatParameters = {
  temperature?: number
  topP?: number
  maxTokens?: number
  frequencyPenalty?: number
  presencePenalty?: number
  seed?: number
}

export type ImageQuality = 'low' | 'medium' | 'high' | 'auto'
export type ImageResolution = '1K' | '2K' | '4K'
export type ImageModelProvider = 'gpt-image' | 'gemini-image' | 'jimeng' | 'grok-image'
export type VideoModelProvider = 'grok-video' | 'minimax-h3'
export type MiniMaxVideoMode = 't2va' | 'i2va' | 'fl2va' | 'l2va' | 'ref2va'
export type MiniMaxVideoResolution = '480p' | '720p'
export type MiniMaxVideoAspectRatio = '16:9' | '9:16' | '1:1' | '4:3' | '3:4' | '21:9' | '9:21' | '4:5' | '5:4'

export type ImageSizePolicy =
  | {
      kind: 'allow-list'
      values: readonly string[]
      default: string
    }
  | {
      kind: 'divisible'
      divisor: number
      min: number
      max: number
      default: string
    }

export type ChatModelCapability = {
  kind: 'chat'
  model: string
  available: true
  hidden: false
  source: 'fallback'
}

export type ImageModelCapability = {
  kind: 'image'
  model: string
  provider: ImageModelProvider
  available: boolean
  hidden: boolean
  source: 'preset' | 'fallback'
  sizePolicy: ImageSizePolicy
  qualities: readonly ImageQuality[]
  defaultQuality?: ImageQuality
  resolutions: readonly ImageResolution[]
  defaultResolution: ImageResolution
  supportsEdits: boolean
  unavailableReason?: string
}

export type VideoModelCapability = {
  kind: 'video'
  model: string
  provider: VideoModelProvider
  available: true
  hidden: false
  source: 'preset'
  minimumSeconds: number
  maximumSeconds: 15
  supportsImageInput: boolean
  supportsVideoInput: boolean
  supportsAudioInput: boolean
}

export type AiModelCapability = ChatModelCapability | ImageModelCapability | VideoModelCapability

export type ChatCompletionsRequestBody = {
  model: string
  messages: AiChatMessage[]
  stream: boolean
  temperature?: number
  top_p?: number
  max_tokens?: number
  frequency_penalty?: number
  presence_penalty?: number
  seed?: number
}

export type ImagesApiGenerationRequestBody = {
  model: string
  prompt: string
  n: 1
  response_format?: 'b64_json'
  size?: string
  quality?: ImageQuality
  extra_fields?: {
    width: number
    height: number
  }
}

export type GeminiImageGenerationRequestBody = {
  model: string
  messages: [{ role: 'user'; content: string }]
  stream: false
  extra_body: {
    google: {
      image_config: {
        aspect_ratio: string
        image_size: ImageResolution
      }
    }
  }
}

export type ImageGenerationRequestBody = ImagesApiGenerationRequestBody | GeminiImageGenerationRequestBody

export type GrokVideoGenerationRequestBody = {
  model: string
  prompt: string
  seconds: string
  image?: string
  width?: number
  height?: number
}

export type MiniMaxVideoGenerationRequestBody = {
  model: string
  mode: MiniMaxVideoMode
  resolution: MiniMaxVideoResolution
  prompt: string
  seconds: string
  aspect_ratio: MiniMaxVideoAspectRatio
  prompt_optimization: boolean
}

export type VideoGenerationRequestBody = GrokVideoGenerationRequestBody | MiniMaxVideoGenerationRequestBody

const allowedVideoDimensions = new Set([
  '1280x720', '720x1280', '1024x1024', '1024x768', '768x1024',
])

export type AiChatProtocolErrorCode =
  | 'invalid-model'
  | 'invalid-group'
  | 'invalid-message'
  | 'input-limit-exceeded'
  | 'invalid-parameter'
  | 'model-not-image'
  | 'model-unavailable'
  | 'invalid-image-size'
  | 'invalid-image-quality'
  | 'invalid-image-resolution'
  | 'model-not-video'
  | 'invalid-video-seconds'
  | 'invalid-video-mode'
  | 'invalid-video-resolution'
  | 'invalid-video-aspect-ratio'
  | 'invalid-video-media'

export class AiChatProtocolError extends Error {
  readonly code: AiChatProtocolErrorCode

  constructor(code: AiChatProtocolErrorCode, message: string) {
    super(message)
    this.name = 'AiChatProtocolError'
    this.code = code
  }
}

const GPT_IMAGE_1_SIZES = ['1024x1024', '1024x1536', '1536x1024', 'auto'] as const
const GPT_IMAGE_QUALITIES = ['low', 'medium', 'high', 'auto'] as const
const ALL_IMAGE_RESOLUTIONS = ['1K', '2K', '4K'] as const
const ONE_K_IMAGE_RESOLUTION = ['1K'] as const

const GPT_IMAGE_1_POLICY: ImageSizePolicy = {
  kind: 'allow-list',
  values: GPT_IMAGE_1_SIZES,
  default: '1024x1024',
}

const GPT_IMAGE_2_POLICY: ImageSizePolicy = {
  kind: 'divisible',
  divisor: 16,
  min: 256,
  max: 4096,
  default: '1024x1024',
}

const JIMENG_POLICY: ImageSizePolicy = {
  kind: 'divisible',
  divisor: 16,
  min: 256,
  max: 1024,
  default: '1024x1024',
}

const GROK_IMAGE_POLICY: ImageSizePolicy = {
  kind: 'allow-list',
  values: ['auto'],
  default: 'auto',
}

const GEMINI_IMAGE_ASPECT_RATIO_BY_SIZE = {
  '1024x1024': '1:1',
  '1536x1152': '4:3',
  '1152x1536': '3:4',
  '1280x720': '16:9',
  '720x1280': '9:16',
  '1536x1024': '3:2',
  '1024x1536': '2:3',
  '1280x1024': '5:4',
  '1024x1280': '4:5',
  '1792x768': '21:9',
} as const

const GEMINI_IMAGE_POLICY: ImageSizePolicy = {
  kind: 'allow-list',
  values: Object.keys(GEMINI_IMAGE_ASPECT_RATIO_BY_SIZE),
  default: '1024x1024',
}

const GPT_IMAGE_2_SIZES_BY_RESOLUTION: Readonly<Record<Exclude<ImageResolution, '1K'>, Readonly<Record<string, string>>>> = {
  '2K': {
    '1024x1024': '2048x2048',
    '1536x1152': '2048x1536',
    '1152x1536': '1536x2048',
    '1280x720': '1920x1088',
    '720x1280': '1088x1920',
    '1536x1024': '2048x1360',
    '1024x1536': '1360x2048',
    '1280x1024': '2048x1648',
    '1024x1280': '1648x2048',
    '1792x768': '2048x880',
  },
  '4K': {
    '1024x1024': '4096x4096',
    '1536x1152': '4096x3072',
    '1152x1536': '3072x4096',
    '1280x720': '3840x2160',
    '720x1280': '2160x3840',
    '1536x1024': '4096x2736',
    '1024x1536': '2736x4096',
    '1280x1024': '4096x3280',
    '1024x1280': '3280x4096',
    '1792x768': '4096x1760',
  },
}

type ImagePresetDefinition = Omit<ImageModelCapability, 'model' | 'source'>

const IMAGE_PRESET_DEFINITIONS = {
  'gemini-3.1-flash-image': {
    kind: 'image',
    provider: 'gemini-image',
    available: true,
    hidden: false,
    sizePolicy: GEMINI_IMAGE_POLICY,
    qualities: [],
    resolutions: ALL_IMAGE_RESOLUTIONS,
    defaultResolution: '1K',
    supportsEdits: false,
  },
  'gpt-image-1': {
    kind: 'image',
    provider: 'gpt-image',
    available: true,
    hidden: false,
    sizePolicy: GPT_IMAGE_1_POLICY,
    qualities: GPT_IMAGE_QUALITIES,
    defaultQuality: 'low',
    resolutions: ONE_K_IMAGE_RESOLUTION,
    defaultResolution: '1K',
    supportsEdits: true,
  },
  'gpt-image-1.5': {
    kind: 'image',
    provider: 'gpt-image',
    available: false,
    hidden: true,
    sizePolicy: GPT_IMAGE_2_POLICY,
    qualities: GPT_IMAGE_QUALITIES,
    defaultQuality: 'low',
    resolutions: ONE_K_IMAGE_RESOLUTION,
    defaultResolution: '1K',
    supportsEdits: true,
    unavailableReason: '当前服务没有该模型的访问权限',
  },
  'gpt-image-2': {
    kind: 'image',
    provider: 'gpt-image',
    available: true,
    hidden: false,
    sizePolicy: GPT_IMAGE_2_POLICY,
    qualities: GPT_IMAGE_QUALITIES,
    defaultQuality: 'low',
    resolutions: ALL_IMAGE_RESOLUTIONS,
    defaultResolution: '1K',
    supportsEdits: true,
  },
  'gpt-image-2-2026-04-21': {
    kind: 'image',
    provider: 'gpt-image',
    available: true,
    hidden: true,
    sizePolicy: GPT_IMAGE_2_POLICY,
    qualities: GPT_IMAGE_QUALITIES,
    defaultQuality: 'low',
    resolutions: ALL_IMAGE_RESOLUTIONS,
    defaultResolution: '1K',
    supportsEdits: true,
  },
  jimeng_high_aes_general_v21_L: {
    kind: 'image',
    provider: 'jimeng',
    available: true,
    hidden: false,
    sizePolicy: JIMENG_POLICY,
    qualities: [],
    resolutions: ONE_K_IMAGE_RESOLUTION,
    defaultResolution: '1K',
    supportsEdits: false,
  },
  'grok-imagine-image': {
    kind: 'image',
    provider: 'grok-image',
    available: true,
    hidden: false,
    sizePolicy: GROK_IMAGE_POLICY,
    qualities: [],
    resolutions: ONE_K_IMAGE_RESOLUTION,
    defaultResolution: '1K',
    supportsEdits: true,
  },
  'grok-imagine-image-2.0': {
    kind: 'image',
    provider: 'grok-image',
    available: true,
    hidden: false,
    sizePolicy: GROK_IMAGE_POLICY,
    qualities: [],
    resolutions: ONE_K_IMAGE_RESOLUTION,
    defaultResolution: '1K',
    supportsEdits: true,
  },
  'grok-imagine-image-quality': {
    kind: 'image',
    provider: 'grok-image',
    available: true,
    hidden: false,
    sizePolicy: GROK_IMAGE_POLICY,
    qualities: [],
    resolutions: ONE_K_IMAGE_RESOLUTION,
    defaultResolution: '1K',
    supportsEdits: true,
  },
} as const satisfies Record<string, ImagePresetDefinition>

export const KNOWN_IMAGE_MODEL_IDS = Object.freeze(
  Object.keys(IMAGE_PRESET_DEFINITIONS) as Array<keyof typeof IMAGE_PRESET_DEFINITIONS>,
)

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/
const GPT_IMAGE_MODEL_PATTERN = /^gpt-image-[a-z0-9][a-z0-9._-]*$/i
const UNAVAILABLE_GPT_IMAGE_15_PATTERN = /^gpt-image-1\.5(?:-|$)/i
const JIMENG_MODEL_PATTERN = /^jimeng_[a-z0-9][a-z0-9_]*$/i
const GROK_IMAGE_MODEL_PATTERN = /^grok-imagine-image(?:-[a-z0-9][a-z0-9._-]*)?$/i
const IMAGE_SIZE_PATTERN = /^(\d{3,4})x(\d{3,4})$/
const MINIMAX_VIDEO_MODEL_PATTERN = /^minimax-h3-(?:mini|fast|base)$/
const MINIMAX_VIDEO_MODES = new Set<MiniMaxVideoMode>(['t2va', 'i2va', 'fl2va', 'l2va', 'ref2va'])
const MINIMAX_VIDEO_RESOLUTIONS = new Set<MiniMaxVideoResolution>(['480p', '720p'])
const MINIMAX_VIDEO_ASPECT_RATIOS = new Set<MiniMaxVideoAspectRatio>([
  '16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '9:21', '4:5', '5:4',
])

function requireBoundedIdentifier(
  value: unknown,
  field: 'model' | 'group',
  maxLength: number,
): string {
  const code = field === 'model' ? 'invalid-model' : 'invalid-group'
  if (typeof value !== 'string') {
    throw new AiChatProtocolError(code, `${field} must be a string`)
  }
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > maxLength || CONTROL_CHARACTER_PATTERN.test(normalized)) {
    throw new AiChatProtocolError(code, `${field} is invalid`)
  }
  return normalized
}

export function validateAiChatGroup(group: AiChatGroup): AiChatGroup {
  if (!group || typeof group !== 'object') {
    throw new AiChatProtocolError('invalid-group', 'group must be an object')
  }
  const id = requireBoundedIdentifier(group.id, 'group', AI_CHAT_LIMITS.groupLength)
  if (typeof group.label !== 'string' || group.label.trim().length === 0 || group.label.length > AI_CHAT_LIMITS.groupLength) {
    throw new AiChatProtocolError('invalid-group', 'group label is invalid')
  }
  if (group.ratio !== undefined && (!Number.isFinite(group.ratio) || group.ratio < 0)) {
    throw new AiChatProtocolError('invalid-group', 'group ratio is invalid')
  }
  return { id, label: group.label.trim(), ...(group.ratio === undefined ? {} : { ratio: group.ratio }) }
}

function createImageCapability(
  model: string,
  definition: ImagePresetDefinition,
  source: ImageModelCapability['source'],
): ImageModelCapability {
  return {
    ...definition,
    model,
    source,
    sizePolicy: definition.sizePolicy.kind === 'allow-list'
      ? { ...definition.sizePolicy, values: [...definition.sizePolicy.values] }
      : { ...definition.sizePolicy },
    qualities: [...definition.qualities],
    resolutions: [...definition.resolutions],
  }
}

export function resolveAiModelCapability(model: string): AiModelCapability {
  const normalized = requireBoundedIdentifier(model, 'model', AI_CHAT_LIMITS.modelLength)
  const preset = IMAGE_PRESET_DEFINITIONS[normalized as keyof typeof IMAGE_PRESET_DEFINITIONS]
  if (preset) return createImageCapability(normalized, preset, 'preset')

  if (normalized === 'grok-imagine-video' || normalized === 'grok-imagine-video-1.5') {
    return {
      kind: 'video', model: normalized, provider: 'grok-video', available: true, hidden: false,
      source: 'preset', minimumSeconds: 1, maximumSeconds: 15,
      supportsImageInput: true, supportsVideoInput: false, supportsAudioInput: false,
    }
  }

  if (MINIMAX_VIDEO_MODEL_PATTERN.test(normalized)) {
    return {
      kind: 'video', model: normalized, provider: 'minimax-h3', available: true, hidden: false,
      source: 'preset', minimumSeconds: 5, maximumSeconds: 15,
      supportsImageInput: true, supportsVideoInput: true, supportsAudioInput: true,
    }
  }

  if (UNAVAILABLE_GPT_IMAGE_15_PATTERN.test(normalized)) {
    return createImageCapability(normalized, IMAGE_PRESET_DEFINITIONS['gpt-image-1.5'], 'fallback')
  }
  if (GPT_IMAGE_MODEL_PATTERN.test(normalized)) {
    return createImageCapability(normalized, IMAGE_PRESET_DEFINITIONS['gpt-image-2'], 'fallback')
  }
  if (JIMENG_MODEL_PATTERN.test(normalized)) {
    return createImageCapability(normalized, IMAGE_PRESET_DEFINITIONS.jimeng_high_aes_general_v21_L, 'fallback')
  }
  if (GROK_IMAGE_MODEL_PATTERN.test(normalized)) {
    return createImageCapability(normalized, IMAGE_PRESET_DEFINITIONS['grok-imagine-image'], 'fallback')
  }
  return {
    kind: 'chat',
    model: normalized,
    available: true,
    hidden: false,
    source: 'fallback',
  }
}

export function getKnownImageModelPresets(options: { includeHidden?: boolean } = {}): ImageModelCapability[] {
  return KNOWN_IMAGE_MODEL_IDS
    .map((model) => createImageCapability(model, IMAGE_PRESET_DEFINITIONS[model], 'preset'))
    .filter((capability) => options.includeHidden || !capability.hidden)
}

export function isImageModel(model: string): boolean {
  return resolveAiModelCapability(model).kind === 'image'
}

export const IMAGE_SKILL_GROUP_NAMES = ['图片模型-中转/订阅', '生图分组'] as const
const IMAGE_GROUP_NAMES = new Set<string>(IMAGE_SKILL_GROUP_NAMES)
const IMAGE_GROUP_MODEL_ORDER = [
  'gpt-image-2',
  'gemini-3.1-flash-image',
  'gpt-image-1',
  'jimeng_high_aes_general_v21_L',
  'grok-imagine-image-2.0',
  'grok-imagine-image-quality',
  'grok-imagine-image',
  'grok-imagine-video-1.5',
  'grok-imagine-video',
  'minimax-h3-base',
  'minimax-h3-fast',
  'minimax-h3-mini',
] as const

export function selectAiChatModelsForGroup(group: string, models: readonly string[]): string[] {
  const unique = [...new Set(models.map((model) => model.trim()).filter(Boolean))]
  const visible = unique.filter((model) => {
    try {
      return !resolveAiModelCapability(model).hidden
    } catch {
      return false
    }
  })
  if (!IMAGE_GROUP_NAMES.has(group.trim())) return visible

  const available = new Set(visible)
  return IMAGE_GROUP_MODEL_ORDER.filter((model) => available.has(model))
}

function validateMessages(messages: readonly AiChatMessage[]): AiChatMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new AiChatProtocolError('invalid-message', 'at least one message is required')
  }
  if (messages.length > AI_CHAT_LIMITS.messageCount) {
    throw new AiChatProtocolError('input-limit-exceeded', 'too many messages')
  }

  let totalLength = 0
  return messages.map((message) => {
    if (!message || typeof message !== 'object' || !['system', 'user', 'assistant'].includes(message.role)) {
      throw new AiChatProtocolError('invalid-message', 'message role is invalid')
    }
    if (typeof message.content !== 'string' || message.content.trim().length === 0) {
      throw new AiChatProtocolError('invalid-message', 'message content is required')
    }
    if (message.content.length > AI_CHAT_LIMITS.messageLength) {
      throw new AiChatProtocolError('input-limit-exceeded', 'message is too long')
    }
    totalLength += message.content.length
    if (totalLength > AI_CHAT_LIMITS.totalMessageLength) {
      throw new AiChatProtocolError('input-limit-exceeded', 'total message content is too long')
    }
    return { role: message.role, content: message.content }
  })
}

function optionalNumber(
  value: number | undefined,
  name: string,
  min: number,
  max: number,
  integer = false,
): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new AiChatProtocolError('invalid-parameter', `${name} is out of range`)
  }
  return value
}

export function buildChatCompletionsRequest(input: {
  model: string
  messages: readonly AiChatMessage[]
  stream?: boolean
  parameters?: AiChatParameters
}): ChatCompletionsRequestBody {
  const capability = resolveAiModelCapability(input.model)
  if (capability.kind !== 'chat') {
    throw new AiChatProtocolError('invalid-model', 'media models cannot use chat completions')
  }
  if (input.stream !== undefined && typeof input.stream !== 'boolean') {
    throw new AiChatProtocolError('invalid-parameter', 'stream must be a boolean')
  }

  const parameters = input.parameters ?? {}
  const temperature = optionalNumber(parameters.temperature, 'temperature', 0, 2)
  const topP = optionalNumber(parameters.topP, 'topP', 0, 1)
  const maxTokens = optionalNumber(parameters.maxTokens, 'maxTokens', 1, AI_CHAT_LIMITS.maxTokens, true)
  const frequencyPenalty = optionalNumber(parameters.frequencyPenalty, 'frequencyPenalty', -2, 2)
  const presencePenalty = optionalNumber(parameters.presencePenalty, 'presencePenalty', -2, 2)
  const seed = optionalNumber(parameters.seed, 'seed', -2_147_483_648, 2_147_483_647, true)

  return {
    model: capability.model,
    messages: validateMessages(input.messages),
    stream: input.stream ?? true,
    ...(temperature === undefined ? {} : { temperature }),
    ...(topP === undefined ? {} : { top_p: topP }),
    ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
    ...(frequencyPenalty === undefined ? {} : { frequency_penalty: frequencyPenalty }),
    ...(presencePenalty === undefined ? {} : { presence_penalty: presencePenalty }),
    ...(seed === undefined ? {} : { seed }),
  }
}

function parseImageDimensions(size: string): { width: number; height: number } | undefined {
  const match = IMAGE_SIZE_PATTERN.exec(size)
  if (!match) return undefined
  return { width: Number(match[1]), height: Number(match[2]) }
}

export function validateImageSize(size: string, capability: ImageModelCapability): string {
  if (typeof size !== 'string') {
    throw new AiChatProtocolError('invalid-image-size', 'image size must be a string')
  }
  const normalized = size.trim().toLowerCase()
  if (capability.sizePolicy.kind === 'allow-list') {
    if (!capability.sizePolicy.values.includes(normalized)) {
      throw new AiChatProtocolError('invalid-image-size', `image size is not supported by ${capability.model}`)
    }
    return normalized
  }

  const dimensions = parseImageDimensions(normalized)
  if (!dimensions) {
    throw new AiChatProtocolError('invalid-image-size', 'image size must use WIDTHxHEIGHT')
  }
  const { divisor, min, max } = capability.sizePolicy
  if (
    dimensions.width < min
    || dimensions.width > max
    || dimensions.height < min
    || dimensions.height > max
    || dimensions.width % divisor !== 0
    || dimensions.height % divisor !== 0
  ) {
    throw new AiChatProtocolError(
      'invalid-image-size',
      `image width and height must be ${divisor} multiples between ${min} and ${max}`,
    )
  }
  return normalized
}

export function validateImageResolution(
  resolution: ImageResolution,
  capability: ImageModelCapability,
): ImageResolution {
  if (!capability.resolutions.includes(resolution)) {
    throw new AiChatProtocolError(
      'invalid-image-resolution',
      `${capability.model} does not support ${resolution} image resolution`,
    )
  }
  return resolution
}

function scaleGptImage2Size(size: string, resolution: ImageResolution): string {
  if (resolution === '1K') return size
  const preset = GPT_IMAGE_2_SIZES_BY_RESOLUTION[resolution][size]
  if (preset) return preset
  const dimensions = parseImageDimensions(size)
  if (!dimensions) throw new AiChatProtocolError('invalid-image-size', 'GPT Image 2 requires explicit dimensions')
  const target = resolution === '2K' ? 2048 : 4096
  const scale = target / Math.max(dimensions.width, dimensions.height)
  const width = Math.max(256, Math.min(4096, Math.round((dimensions.width * scale) / 16) * 16))
  const height = Math.max(256, Math.min(4096, Math.round((dimensions.height * scale) / 16) * 16))
  return `${width}x${height}`
}

export function buildImageGenerationRequest(input: {
  model: string
  prompt: string
  size?: string
  quality?: ImageQuality
  imageResolution?: ImageResolution
}): ImageGenerationRequestBody {
  const capability = resolveAiModelCapability(input.model)
  if (capability.kind !== 'image') {
    throw new AiChatProtocolError('model-not-image', 'chat models cannot use image generations')
  }
  if (!capability.available) {
    throw new AiChatProtocolError(
      'model-unavailable',
      capability.unavailableReason ?? 'image model is unavailable',
    )
  }
  if (typeof input.prompt !== 'string' || input.prompt.trim().length === 0) {
    throw new AiChatProtocolError('invalid-message', 'image prompt is required')
  }
  const imageResolution = validateImageResolution(
    input.imageResolution ?? capability.defaultResolution,
    capability,
  )

  if (capability.provider === 'grok-image') {
    // xAI otherwise returns a short-lived imgen.x.ai URL. Asking new-api for
    // base64 avoids a second network hop and keeps the generated result
    // recoverable when the user's DNS proxy exposes CDN hosts as Fake-IP.
    return { model: capability.model, prompt: input.prompt, n: 1, response_format: 'b64_json' }
  }

  const size = validateImageSize(input.size ?? capability.sizePolicy.default, capability)
  if (capability.provider === 'gemini-image') {
    const aspectRatio = GEMINI_IMAGE_ASPECT_RATIO_BY_SIZE[size as keyof typeof GEMINI_IMAGE_ASPECT_RATIO_BY_SIZE]
    if (!aspectRatio) {
      throw new AiChatProtocolError('invalid-image-size', 'Gemini image aspect ratio is not supported')
    }
    return {
      model: capability.model,
      messages: [{ role: 'user', content: input.prompt }],
      stream: false,
      extra_body: {
        google: {
          image_config: { aspect_ratio: aspectRatio, image_size: imageResolution },
        },
      },
    }
  }
  if (capability.provider === 'jimeng') {
    const dimensions = parseImageDimensions(size)
    if (!dimensions) {
      throw new AiChatProtocolError('invalid-image-size', 'Jimeng requires explicit dimensions')
    }
    return {
      model: capability.model,
      prompt: input.prompt,
      n: 1,
      extra_fields: dimensions,
    }
  }

  const quality = input.quality ?? capability.defaultQuality ?? 'low'
  if (!capability.qualities.includes(quality)) {
    throw new AiChatProtocolError('invalid-image-quality', `quality is not supported by ${capability.model}`)
  }
  return {
    model: capability.model,
    prompt: input.prompt,
    n: 1,
    size: /^gpt-image-2(?:-|$)/i.test(capability.model)
      ? validateImageSize(scaleGptImage2Size(size, imageResolution), capability)
      : size,
    quality,
  }
}

export function buildVideoGenerationRequest(input: {
  model: string
  prompt: string
  seconds: string
  image?: string
  width?: number
  height?: number
  mode?: MiniMaxVideoMode
  resolution?: MiniMaxVideoResolution
  aspectRatio?: MiniMaxVideoAspectRatio
  promptOptimization?: boolean
  imageCount?: number
  videoCount?: number
  audioCount?: number
}): VideoGenerationRequestBody {
  const capability = resolveAiModelCapability(input.model)
  if (capability.kind !== 'video') {
    throw new AiChatProtocolError('model-not-video', 'only verified video models can use video generations')
  }
  if (typeof input.prompt !== 'string' || input.prompt.trim().length === 0) {
    throw new AiChatProtocolError('invalid-message', 'video prompt is required')
  }
  const maximumPromptLength = capability.provider === 'minimax-h3' ? 30_000 : AI_CHAT_LIMITS.promptLength
  if (input.prompt.length > maximumPromptLength) {
    throw new AiChatProtocolError('input-limit-exceeded', 'video prompt is too long')
  }
  const seconds = typeof input.seconds === 'string' && /^(?:[1-9]|1[0-5])$/.test(input.seconds)
    ? Number(input.seconds)
    : Number.NaN
  if (!Number.isInteger(seconds) || seconds < capability.minimumSeconds || seconds > capability.maximumSeconds) {
    throw new AiChatProtocolError(
      'invalid-video-seconds',
      `video seconds must be an integer string between ${capability.minimumSeconds} and ${capability.maximumSeconds}`,
    )
  }

  const imageCount = input.imageCount ?? (input.image ? 1 : 0)
  const videoCount = input.videoCount ?? 0
  const audioCount = input.audioCount ?? 0
  if (![imageCount, videoCount, audioCount].every((count) => Number.isSafeInteger(count) && count >= 0)) {
    throw new AiChatProtocolError('invalid-video-media', 'video media counts are invalid')
  }

  if (capability.provider === 'minimax-h3') {
    if (!input.mode || !MINIMAX_VIDEO_MODES.has(input.mode)) {
      throw new AiChatProtocolError('invalid-video-mode', 'MiniMax video mode is invalid')
    }
    const resolution = input.resolution ?? '720p'
    if (!MINIMAX_VIDEO_RESOLUTIONS.has(resolution)) {
      throw new AiChatProtocolError('invalid-video-resolution', 'MiniMax video resolution is invalid')
    }
    const aspectRatio = input.aspectRatio ?? '16:9'
    if (!MINIMAX_VIDEO_ASPECT_RATIOS.has(aspectRatio)) {
      throw new AiChatProtocolError('invalid-video-aspect-ratio', 'MiniMax video aspect ratio is invalid')
    }
    if (imageCount > 9 || videoCount > 3 || audioCount > 3 || imageCount + videoCount + audioCount > 15) {
      throw new AiChatProtocolError('invalid-video-media', 'MiniMax video media count exceeds the API limit')
    }
    const mediaCount = imageCount + videoCount + audioCount
    if (input.mode === 't2va' && mediaCount !== 0) {
      throw new AiChatProtocolError('invalid-video-media', 'T2VA does not accept media inputs')
    }
    if ((input.mode === 'i2va' || input.mode === 'l2va') && (imageCount !== 1 || videoCount !== 0 || audioCount !== 0)) {
      throw new AiChatProtocolError('invalid-video-media', `${input.mode.toUpperCase()} requires exactly one image`)
    }
    if (input.mode === 'fl2va' && ((imageCount !== 1 && imageCount !== 2) || videoCount !== 0 || audioCount !== 0)) {
      throw new AiChatProtocolError('invalid-video-media', 'FL2VA requires one or two images')
    }
    if (input.mode === 'ref2va' && mediaCount === 0) {
      throw new AiChatProtocolError('invalid-video-media', 'Ref2VA requires at least one media input')
    }
    if (input.image !== undefined || input.width !== undefined || input.height !== undefined) {
      throw new AiChatProtocolError('invalid-video-media', 'MiniMax media must be sent as owned multipart assets')
    }
    if (input.promptOptimization !== undefined && typeof input.promptOptimization !== 'boolean') {
      throw new AiChatProtocolError('invalid-parameter', 'promptOptimization must be a boolean')
    }
    return {
      model: capability.model,
      mode: input.mode,
      resolution,
      prompt: input.prompt,
      seconds: input.seconds,
      aspect_ratio: aspectRatio,
      prompt_optimization: input.promptOptimization ?? false,
    }
  }

  if (videoCount > 0 || audioCount > 0 || imageCount > 1) {
    throw new AiChatProtocolError('invalid-video-media', 'Grok video accepts at most one image input')
  }
  if (input.image !== undefined && (
    typeof input.image !== 'string'
    || input.image.length === 0
    || input.image.length > AI_CHAT_LIMITS.videoImageLength
    || !input.image.startsWith('data:image/')
  )) {
    throw new AiChatProtocolError('input-limit-exceeded', 'video image input is invalid or too large')
  }
  const hasWidth = input.width !== undefined
  const hasHeight = input.height !== undefined
  if (hasWidth !== hasHeight || (hasWidth && (
    !Number.isSafeInteger(input.width)
    || !Number.isSafeInteger(input.height)
    || !allowedVideoDimensions.has(`${input.width}x${input.height}`)
  ))) {
    throw new AiChatProtocolError('invalid-parameter', 'video dimensions are not supported')
  }
  return {
    model: capability.model,
    prompt: input.prompt,
    seconds: input.seconds,
    ...(input.image ? { image: input.image } : {}),
    ...(hasWidth ? { width: input.width, height: input.height } : {}),
  }
}

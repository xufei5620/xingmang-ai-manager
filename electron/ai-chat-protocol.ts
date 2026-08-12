export const AI_CHAT_ENDPOINTS = {
  chatCompletions: '/v1/chat/completions',
  imageGenerations: '/v1/images/generations',
  imageEdits: '/v1/images/edits',
} as const

export const AI_CHAT_LIMITS = {
  modelLength: 128,
  groupLength: 128,
  messageCount: 100,
  messageLength: 40_000,
  totalMessageLength: 120_000,
  promptLength: 40_000,
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
export type ImageModelProvider = 'gpt-image' | 'jimeng'

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
  unavailableReason?: string
}

export type AiModelCapability = ChatModelCapability | ImageModelCapability

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

export type ImageGenerationRequestBody = {
  model: string
  prompt: string
  n: 1
  size?: string
  quality?: ImageQuality
  extra_fields?: {
    width: number
    height: number
  }
}

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

type ImagePresetDefinition = Omit<ImageModelCapability, 'model' | 'source'>

const IMAGE_PRESET_DEFINITIONS = {
  'gpt-image-1': {
    kind: 'image',
    provider: 'gpt-image',
    available: true,
    hidden: false,
    sizePolicy: GPT_IMAGE_1_POLICY,
    qualities: GPT_IMAGE_QUALITIES,
    defaultQuality: 'low',
  },
  'gpt-image-1.5': {
    kind: 'image',
    provider: 'gpt-image',
    available: false,
    hidden: true,
    sizePolicy: GPT_IMAGE_2_POLICY,
    qualities: GPT_IMAGE_QUALITIES,
    defaultQuality: 'low',
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
  },
  'gpt-image-2-2026-04-21': {
    kind: 'image',
    provider: 'gpt-image',
    available: true,
    hidden: true,
    sizePolicy: GPT_IMAGE_2_POLICY,
    qualities: GPT_IMAGE_QUALITIES,
    defaultQuality: 'low',
  },
  jimeng_high_aes_general_v21_L: {
    kind: 'image',
    provider: 'jimeng',
    available: true,
    hidden: false,
    sizePolicy: JIMENG_POLICY,
    qualities: [],
  },
} as const satisfies Record<string, ImagePresetDefinition>

export const KNOWN_IMAGE_MODEL_IDS = Object.freeze(
  Object.keys(IMAGE_PRESET_DEFINITIONS) as Array<keyof typeof IMAGE_PRESET_DEFINITIONS>,
)

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/
const GPT_IMAGE_MODEL_PATTERN = /^gpt-image-[a-z0-9][a-z0-9._-]*$/i
const UNAVAILABLE_GPT_IMAGE_15_PATTERN = /^gpt-image-1\.5(?:-|$)/i
const JIMENG_MODEL_PATTERN = /^jimeng_[a-z0-9][a-z0-9_]*$/i
const IMAGE_SIZE_PATTERN = /^(\d{3,4})x(\d{3,4})$/

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
  }
}

export function resolveAiModelCapability(model: string): AiModelCapability {
  const normalized = requireBoundedIdentifier(model, 'model', AI_CHAT_LIMITS.modelLength)
  const preset = IMAGE_PRESET_DEFINITIONS[normalized as keyof typeof IMAGE_PRESET_DEFINITIONS]
  if (preset) return createImageCapability(normalized, preset, 'preset')

  if (UNAVAILABLE_GPT_IMAGE_15_PATTERN.test(normalized)) {
    return createImageCapability(normalized, IMAGE_PRESET_DEFINITIONS['gpt-image-1.5'], 'fallback')
  }
  if (GPT_IMAGE_MODEL_PATTERN.test(normalized)) {
    return createImageCapability(normalized, IMAGE_PRESET_DEFINITIONS['gpt-image-2'], 'fallback')
  }
  if (JIMENG_MODEL_PATTERN.test(normalized)) {
    return createImageCapability(normalized, IMAGE_PRESET_DEFINITIONS.jimeng_high_aes_general_v21_L, 'fallback')
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

const IMAGE_GROUP_NAME = '生图分组'
const IMAGE_GROUP_MODEL_ORDER = [
  'gpt-image-2',
  'gpt-image-1',
  'jimeng_high_aes_general_v21_L',
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
  if (group.trim() !== IMAGE_GROUP_NAME) return visible

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
  if (capability.kind === 'image') {
    throw new AiChatProtocolError('invalid-model', 'image models cannot use chat completions')
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

export function buildImageGenerationRequest(input: {
  model: string
  prompt: string
  size?: string
  quality?: ImageQuality
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
  if (input.prompt.length > AI_CHAT_LIMITS.promptLength) {
    throw new AiChatProtocolError('input-limit-exceeded', 'image prompt is too long')
  }

  const size = validateImageSize(input.size ?? capability.sizePolicy.default, capability)
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
    size,
    quality,
  }
}

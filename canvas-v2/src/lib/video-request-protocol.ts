export const videoRequestProtocolRevision = 1
export const maximumGeneratedVideoBytes = 32 * 1024 * 1024
export const maximumVideoReferenceBytes = 32 * 1024 * 1024
export type VideoProtocol = 'relay-videos' | 'xai-native' | 'ark-seedance'
export type VideoRequestProvider = 'grok-video' | 'minimax-h3' | 'seedance'
export type VideoRequestMode = 'auto' | 't2va' | 'i2va' | 'fl2va' | 'l2va' | 'ref2va'
export type VideoRequestResolution = '480p' | '720p' | '1080p'
export type VideoRequestAspectRatio = '16:9' | '9:16' | '1:1' | '4:3' | '3:4' | '21:9' | '9:21' | '4:5' | '5:4' | '3:2' | '2:3' | '5:2' | 'adaptive'
export interface VideoRequestInput {
  videoProtocol?: VideoProtocol
  generateAudio?: boolean
  model: string
  prompt: string
  seconds?: string
  size?: string
  videoMode?: VideoRequestMode
  videoResolution?: VideoRequestResolution
  videoAspectRatio?: VideoRequestAspectRatio
  promptOptimization?: boolean
  imageCount?: number
  videoCount?: number
  audioCount?: number
}
export interface VideoRequestParameters {
  provider: VideoRequestProvider
  protocolRevision: number
  /** Absent preserves the original relay request and its immutable digest. */
  videoProtocol?: 'xai-native' | 'ark-seedance'
  body: { model: string; prompt: string; seconds?: string; duration?: number; generate_audio?: boolean; width?: number; height?: number; mode?: Exclude<VideoRequestMode, 'auto'>; resolution?: VideoRequestResolution; aspect_ratio?: VideoRequestAspectRatio; prompt_optimization?: boolean; execution_expires_after?: number }
}
export class VideoRequestError extends Error {
  readonly status: number
  constructor(message: string, status = 422) { super(message); this.name = 'VideoRequestError'; this.status = status }
}

const modes = new Set(['auto', 't2va', 'i2va', 'fl2va', 'l2va', 'ref2va'])
const ratios = new Set(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '9:21', '4:5', '5:4'])
const grokSizes = new Set(['1280x720', '720x1280', '1024x1024', '1024x768', '768x1024'])
const videoSizeAspectRatios: Readonly<Record<string, VideoRequestAspectRatio>> = { '1280x720': '16:9', '720x1280': '9:16', '1024x1024': '1:1', '1024x768': '4:3', '768x1024': '3:4' }

export interface VideoModelParameterInspection {
  errors: string[]
  /** Explicit patch, including undefined keys which clear inapplicable settings. */
  reset: Partial<VideoRequestInput>
  resetLabels: string[]
}

/** Native capabilities come from xAI's documented generation protocol, not a model-name guess. */
export const xaiNativeVideoModels = ['grok-imagine-video', 'grok-imagine-video-1.5', 'grok-imagine-video-1.5-lite'] as const
export const xaiNativeVideoRatios = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9', '5:2'] as const
export const xaiNativeVideoResolutions = ['480p', '720p', '1080p'] as const
export const xaiNativeVideoDefaults = { seconds: '8', resolution: '480p', aspectRatio: '16:9' } as const
/** Seedance 2.0 Mini only: do not infer another model's capabilities from its name. */
export const arkSeedanceVideoModels = ['doubao-seedance-2-0-mini-260615'] as const
export const arkSeedanceVideoResolutions = ['480p', '720p'] as const
export const arkSeedanceVideoRatios = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'] as const
export const arkSeedanceVideoModes = ['auto', 't2va', 'i2va', 'fl2va', 'ref2va'] as const
export const arkSeedanceVideoDefaults = { seconds: '5', resolution: '720p', aspectRatio: 'adaptive', size: 'auto' } as const
export const arkSeedanceVideoDurationRange = { min: 4, max: 15 } as const
/** The combined limit is our bounded canvas budget, not an upstream aggregate claim. */
export const arkSeedanceVideoReferenceLimits = { images: 9, videos: 3, audios: 3, total: 12 } as const
export const arkSeedanceExecutionExpiresAfter = 3600
export function videoAspectRatioFromSize(size: string | undefined): VideoRequestAspectRatio | undefined { return size ? videoSizeAspectRatios[size] : undefined }
export function parseVideoProtocol(value: unknown): VideoProtocol {
  if (value === undefined || value === 'relay-videos') return 'relay-videos'
  if (value === 'xai-native' || value === 'ark-seedance') return value
  throw new VideoRequestError('视频来源协议不正确，请重新选择已接通的来源')
}
export function xaiNativeVideoModelSupported(model: string): boolean { return (xaiNativeVideoModels as readonly string[]).includes(model) }
export function xaiNativeVideoModelResolutions(model: string): readonly VideoRequestResolution[] { return model === 'grok-imagine-video' ? ['480p', '720p'] : xaiNativeVideoModelSupported(model) ? xaiNativeVideoResolutions : [] }
export function arkSeedanceVideoModelSupported(model: string): boolean { return (arkSeedanceVideoModels as readonly string[]).includes(model) }
export function arkSeedanceVideoModelResolutions(model: string): readonly VideoRequestResolution[] { return arkSeedanceVideoModelSupported(model) ? arkSeedanceVideoResolutions : [] }

function inspectArkSeedanceVideoParameters(input: VideoRequestInput): VideoModelParameterInspection {
  const errors: string[] = [], reset: Partial<VideoRequestInput> = {}, resetLabels: string[] = []
  function invalid(message: string, label: string, patch: Partial<VideoRequestInput>): void { errors.push(message); resetLabels.push(label); Object.assign(reset, patch) }
  if (!arkSeedanceVideoModelSupported(input.model)) return { errors: ['此模型尚未接通 Ark Seedance 原生协议，请选择已核实的 Seedance 2.0 Mini 模型'], reset, resetLabels }
  if (input.seconds !== undefined && (typeof input.seconds !== 'string' || !/^(?:[4-9]|1[0-5])$/.test(input.seconds))) invalid('Seedance 2.0 Mini 时长需为 4–15 秒的整数', '时长', { seconds: arkSeedanceVideoDefaults.seconds })
  if (input.generateAudio !== undefined && typeof input.generateAudio !== 'boolean') invalid('视频生成音频开关不正确', '生成音频', { generateAudio: undefined })
  if (input.videoResolution !== undefined && !arkSeedanceVideoModelResolutions(input.model).includes(input.videoResolution)) invalid('Seedance 2.0 Mini 仅支持 480p 或 720p，请核对并重置', '视频分辨率', { videoResolution: arkSeedanceVideoDefaults.resolution })
  if (input.videoAspectRatio !== undefined && !(arkSeedanceVideoRatios as readonly string[]).includes(input.videoAspectRatio)) invalid('Seedance 视频比例不支持，请核对并重置', '视频比例', { videoAspectRatio: arkSeedanceVideoDefaults.aspectRatio })
  if (input.videoMode !== undefined && !(arkSeedanceVideoModes as readonly string[]).includes(input.videoMode)) invalid('Seedance 当前仅支持自动、文生、首帧、首尾帧及多模态参考，不支持独立尾帧模式', '生成模式', { videoMode: 'auto' })
  if (input.promptOptimization !== undefined && input.promptOptimization !== false) invalid('Seedance 原生协议尚未接通提示词优化参数，请关闭后运行', '提示词优化', { promptOptimization: undefined })
  const neutralSize = input.size === undefined || input.size === '' || input.size === 'auto' || input.size === '1280x720' || input.size === '1280x736'
  const sizeRatio = videoAspectRatioFromSize(input.size)
  if (!neutralSize && (!sizeRatio || input.videoAspectRatio !== undefined && input.videoAspectRatio !== sizeRatio)) invalid('保留的固定尺寸与 Seedance 比例不一致，请重置为自动尺寸', '画面尺寸', { size: 'auto' })
  return { errors, reset, resetLabels }
}

function inspectXaiNativeVideoParameters(input: VideoRequestInput): VideoModelParameterInspection {
  const errors: string[] = [], reset: Partial<VideoRequestInput> = {}, resetLabels: string[] = []
  function invalid(message: string, label: string, patch: Partial<VideoRequestInput>): void { errors.push(message); resetLabels.push(label); Object.assign(reset, patch) }
  if (!xaiNativeVideoModelSupported(input.model)) return { errors: ['此模型尚未接通 xAI 原生视频协议，请从已读取的 Grok 视频模型中选择'], reset, resetLabels }
  if (input.seconds !== undefined && (typeof input.seconds !== 'string' || !/^(?:[1-9]|1[0-5])$/.test(input.seconds))) invalid('xAI 原生视频时长需为 1–15 秒的整数', '时长', { seconds: xaiNativeVideoDefaults.seconds })
  if (input.generateAudio !== undefined && typeof input.generateAudio !== 'boolean') invalid('视频生成音频开关不正确', '生成音频', { generateAudio: undefined })
  if (input.videoResolution !== undefined && !xaiNativeVideoModelResolutions(input.model).includes(input.videoResolution)) invalid('此 xAI 视频模型不支持保留的分辨率，请核对并重置', '视频分辨率', { videoResolution: xaiNativeVideoDefaults.resolution })
  if (input.videoMode !== undefined && !['auto', 't2va', 'i2va'].includes(input.videoMode)) invalid('xAI 原生适配当前接通文生视频和单图首帧，其他模式尚未接通', '生成模式', { videoMode: 'auto' })
  if (input.promptOptimization !== undefined && input.promptOptimization !== false) invalid('xAI 原生视频不支持此提示词优化参数，请核对并关闭', '提示词优化', { promptOptimization: undefined })
  const imageInput = (input.imageCount ?? 0) > 0 || input.videoMode === 'i2va'
  const neutralSize = !input.size || input.size === '1280x720' || input.size === '1280x736'
  const sizeRatio = videoAspectRatioFromSize(input.size)
  if (imageInput) {
    if (input.videoAspectRatio !== undefined) invalid('xAI 图生视频比例随输入图片，显式视频比例不会生效，请清除后运行', '视频比例', { videoAspectRatio: undefined })
    if (!neutralSize) invalid('xAI 图生视频画面随输入图片，保留的固定尺寸不会生效，请重置', '画面尺寸', { size: '1280x720' })
  } else {
    if (input.videoAspectRatio !== undefined && !(xaiNativeVideoRatios as readonly string[]).includes(input.videoAspectRatio)) invalid('xAI 原生视频不支持保留的画面比例，请核对并重置', '视频比例', { videoAspectRatio: xaiNativeVideoDefaults.aspectRatio })
    if (!neutralSize && (!sizeRatio || input.videoAspectRatio !== undefined && input.videoAspectRatio !== sizeRatio)) invalid('保留的画面尺寸与 xAI 原生视频比例不一致，请重置尺寸', '画面尺寸', { size: '1280x720' })
  }
  return { errors, reset, resetLabels }
}

/** Each explicit source protocol owns its accepted parameters and reset hints. */
export function inspectVideoModelParameters(input: Omit<VideoRequestInput, 'prompt'> & { prompt?: string }): VideoModelParameterInspection {
  if (input.videoProtocol === 'xai-native') return inspectXaiNativeVideoParameters({ ...input, prompt: input.prompt ?? '' })
  if (input.videoProtocol === 'ark-seedance') return inspectArkSeedanceVideoParameters({ ...input, prompt: input.prompt ?? '' })
  const errors: string[] = [], reset: Partial<VideoRequestInput> = {}, resetLabels: string[] = []
  function invalid(message: string, label: string, patch: Partial<VideoRequestInput>): void { errors.push(message); resetLabels.push(label); Object.assign(reset, patch) }
  if (input.videoProtocol !== undefined && input.videoProtocol !== 'relay-videos') invalid('视频来源协议不正确', '来源协议', {})
  if (input.generateAudio !== undefined) invalid('当前中转视频协议未接通生成音频开关，请清除音频设置或选择 xAI 原生来源', '生成音频', { generateAudio: undefined })
  const grok = input.model === 'grok-imagine-video' || input.model === 'grok-imagine-video-1.5'
  const minimax = /^minimax-h3-(?:mini|fast|base)$/.test(input.model)
  if (!grok && !minimax) return { errors: ['此视频模型的中转请求协议尚未接通，当前不会提交生成'], reset, resetLabels }
  if (input.seconds !== undefined && (typeof input.seconds !== 'string' || !/^(?:[1-9]|1[0-5])$/.test(input.seconds) || minimax && Number(input.seconds) < 5)) invalid('视频时长与当前模型不兼容，请重置视频参数', '时长', { seconds: '5' })
  if (grok) {
    const size = input.size || '1280x720'
    if (!grokSizes.has(size)) invalid('Grok 视频尺寸不支持，请重置视频参数', '画面尺寸', { size: '1280x720' })
    if (input.videoMode !== undefined && input.videoMode !== 'auto') invalid('Grok 当前中转协议不接受显式 MiniMax 生成模式，请核对并重置模式', '生成模式', { videoMode: undefined })
    const ratio = videoSizeAspectRatios[size]
    if (input.videoAspectRatio !== undefined && input.videoAspectRatio !== ratio) invalid('保留的视频比例与 Grok 画面尺寸不一致，请核对并重置比例', '视频比例', { videoAspectRatio: undefined })
    if (input.videoResolution !== undefined && (input.videoResolution !== '720p' || !['1280x720', '720x1280'].includes(size))) invalid('保留的视频分辨率与 Grok 当前中转尺寸不兼容，请核对并重置分辨率', '视频分辨率', { videoResolution: undefined })
    if (input.promptOptimization !== undefined && input.promptOptimization !== false) invalid('Grok 当前中转协议不接受提示词优化，请核对并关闭此参数', '提示词优化', { promptOptimization: undefined })
  } else {
    // Desktop nodes retained 1280x720, and MiniMax presets retained 1280x736,
    // as inactive defaults even when an explicit aspect ratio was selected.
    // Templates also carry a meaningful pixel layout for Grok portability:
    // accept it only when MiniMax's explicit ratio expresses the same layout.
    const neutralSize = input.size === undefined || input.size === '' || input.size === '1280x720' || input.size === '1280x736'
    const matchingLayout = typeof input.size === 'string' && input.videoAspectRatio !== undefined && videoSizeAspectRatios[input.size] === input.videoAspectRatio
    if (!neutralSize && !matchingLayout) invalid('保留的画面尺寸与 MiniMax 视频比例不一致，请核对并重置尺寸', '画面尺寸', { size: '1280x720' })
    if (input.videoMode !== undefined && !modes.has(input.videoMode)) invalid('MiniMax 视频模式不正确', '生成模式', { videoMode: 'auto' })
    if (input.videoResolution !== undefined && !['480p', '720p'].includes(input.videoResolution)) invalid('MiniMax 视频分辨率需为 480p 或 720p', '视频分辨率', { videoResolution: '720p' })
    if (input.videoAspectRatio !== undefined && !ratios.has(input.videoAspectRatio)) invalid('MiniMax 视频比例不支持', '视频比例', { videoAspectRatio: '16:9' })
    if (input.promptOptimization !== undefined && typeof input.promptOptimization !== 'boolean') invalid('提示词优化开关不正确', '提示词优化', { promptOptimization: false })
  }
  return { errors, reset, resetLabels }
}

export function videoRequestParameters(input: VideoRequestInput, options: { legacyInactiveParameters?: boolean } = {}): VideoRequestParameters {
  if (!input || typeof input.model !== 'string' || input.model !== input.model.trim() || input.model.length > 256) throw new VideoRequestError('视频模型编号不正确')
  const protocol = parseVideoProtocol(input.videoProtocol)
  if (protocol === 'xai-native') return xaiNativeVideoRequestParameters(input)
  if (protocol === 'ark-seedance') return arkSeedanceVideoRequestParameters(input)
  if (input.generateAudio !== undefined) throw new VideoRequestError('当前中转视频协议未接通生成音频开关，不会忽略设置继续生成')
  const provider = input.model === 'grok-imagine-video' || input.model === 'grok-imagine-video-1.5' ? 'grok-video' : /^minimax-h3-(?:mini|fast|base)$/.test(input.model) ? 'minimax-h3' : null
  if (!provider) throw new VideoRequestError('此视频模型的请求协议尚未验证，请选择 Grok 视频或 MiniMax H3 模型；当前不会提交生成请求')
  const compatibility = inspectVideoModelParameters(input)
  if (!options.legacyInactiveParameters && compatibility.errors.length) throw new VideoRequestError(compatibility.errors.join('；'))
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > (provider === 'minimax-h3' ? 30_000 : 40_000)) throw new VideoRequestError('视频提示词不能为空或超过模型安全长度')
  const seconds = input.seconds ?? '5'
  if (typeof seconds !== 'string' || !/^(?:[1-9]|1[0-5])$/.test(seconds) || Number(seconds) < (provider === 'minimax-h3' ? 5 : 1)) throw new VideoRequestError(provider === 'minimax-h3' ? 'MiniMax 视频时长需为 5–15 秒的整数' : 'Grok 视频时长需为 1–15 秒的整数')
  const imageCount = input.imageCount ?? 0
  const videoCount = input.videoCount ?? 0
  const audioCount = input.audioCount ?? 0
  if (![imageCount, videoCount, audioCount].every((value) => Number.isSafeInteger(value) && value >= 0)) throw new VideoRequestError('视频参考素材数量不正确')
  if (videoCount !== 0) throw new VideoRequestError('当前已验证的视频模型不支持参考视频，请移除参考视频；当前不会提交生成请求')
  const body: VideoRequestParameters['body'] = { model: input.model, prompt: input.prompt, seconds }
  if (provider === 'grok-video') {
    if (imageCount > 1 || audioCount !== 0) throw new VideoRequestError('Grok 视频最多使用一张参考图片，不支持参考音频')
    const size = input.size || '1280x720'
    if (!grokSizes.has(size)) throw new VideoRequestError('Grok 视频尺寸不支持，请选择已验证尺寸')
    const [width, height] = size.split('x').map(Number)
    body.width = width
    body.height = height
  } else {
    if (imageCount > 9 || audioCount > 3 || imageCount + audioCount > 12) throw new VideoRequestError('MiniMax 最多使用 9 张图片和 3 个音频，参考素材总数不能超过 12')
    if (input.videoMode !== undefined && !modes.has(input.videoMode)) throw new VideoRequestError('MiniMax 视频模式不正确')
    const mode = input.videoMode && input.videoMode !== 'auto' ? input.videoMode : audioCount > 0 || imageCount > 2 ? 'ref2va' : imageCount === 2 ? 'fl2va' : imageCount === 1 ? 'i2va' : 't2va'
    if (mode === 't2va' && imageCount + audioCount !== 0) throw new VideoRequestError('文生视频模式不接受参考素材')
    if ((mode === 'i2va' || mode === 'l2va') && (imageCount !== 1 || audioCount !== 0)) throw new VideoRequestError('图生视频或尾帧模式需要且仅接受一张图片')
    if (mode === 'fl2va' && (imageCount !== 2 || audioCount !== 0)) throw new VideoRequestError('首尾帧模式需要且仅接受两张图片')
    if (mode === 'ref2va' && imageCount + audioCount === 0) throw new VideoRequestError('参考素材模式需要至少一张图片或一个音频')
    if (input.videoResolution !== undefined && !['480p', '720p'].includes(input.videoResolution)) throw new VideoRequestError('MiniMax 视频分辨率需为 480p 或 720p')
    if (input.videoAspectRatio !== undefined && !ratios.has(input.videoAspectRatio)) throw new VideoRequestError('MiniMax 视频比例不支持')
    if (input.promptOptimization !== undefined && typeof input.promptOptimization !== 'boolean') throw new VideoRequestError('提示词优化开关不正确')
    body.mode = mode
    body.resolution = input.videoResolution ?? '720p'
    body.aspect_ratio = input.videoAspectRatio ?? '16:9'
    body.prompt_optimization = input.promptOptimization ?? false
  }
  return { provider, protocolRevision: videoRequestProtocolRevision, body }
}

function xaiNativeVideoRequestParameters(input: VideoRequestInput): VideoRequestParameters {
  const inspection = inspectXaiNativeVideoParameters(input)
  if (inspection.errors.length) throw new VideoRequestError(inspection.errors.join('；'))
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 40_000) throw new VideoRequestError('视频提示词不能为空或超过安全长度')
  const imageCount = input.imageCount ?? 0, audioCount = input.audioCount ?? 0, videoCount = input.videoCount ?? 0
  if (![imageCount, audioCount, videoCount].every((value) => Number.isSafeInteger(value) && value >= 0)) throw new VideoRequestError('视频参考素材数量不正确')
  if (imageCount > 1 || audioCount !== 0 || videoCount !== 0) throw new VideoRequestError('xAI 原生适配当前仅接受零张或一张首帧图片，不接受多图、参考音频或视频')
  if (input.videoMode === 't2va' && imageCount !== 0 || input.videoMode === 'i2va' && imageCount !== 1) throw new VideoRequestError('xAI 文生模式需要零张图片，图生模式需要且仅接受一张图片')
  return { provider: 'grok-video', protocolRevision: videoRequestProtocolRevision, videoProtocol: 'xai-native', body: { model: input.model, prompt: input.prompt, duration: Number(input.seconds ?? xaiNativeVideoDefaults.seconds), resolution: input.videoResolution ?? xaiNativeVideoDefaults.resolution, ...(imageCount === 0 ? { aspect_ratio: input.videoAspectRatio ?? videoAspectRatioFromSize(input.size) ?? xaiNativeVideoDefaults.aspectRatio } : {}), ...(input.generateAudio === undefined ? {} : { generate_audio: input.generateAudio }) } }
}

function arkSeedanceVideoRequestParameters(input: VideoRequestInput): VideoRequestParameters {
  const inspection = inspectArkSeedanceVideoParameters(input)
  if (inspection.errors.length) throw new VideoRequestError(inspection.errors.join('；'))
  // SDK-wide parameters do not establish support for this exact model. Never
  // silently discard an unsupported seed, camera or output contract.
  for (const field of ['seed', 'cameraFixed', 'camera_fixed', 'returnLastFrame', 'return_last_frame', 'execution_expires_after', 'frames', 'output_format', 'draft', 'service_tier']) if (Object.prototype.hasOwnProperty.call(input, field)) throw new VideoRequestError('Seedance 包含尚未接通的参数，请清除后运行')
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 40_000) throw new VideoRequestError('视频提示词不能为空或超过安全长度')
  const imageCount = input.imageCount ?? 0, videoCount = input.videoCount ?? 0, audioCount = input.audioCount ?? 0
  if (![imageCount, videoCount, audioCount].every((value) => Number.isSafeInteger(value) && value >= 0)) throw new VideoRequestError('视频参考素材数量不正确')
  const limits = arkSeedanceVideoReferenceLimits
  if (imageCount > limits.images || videoCount > limits.videos || audioCount > limits.audios || imageCount + videoCount + audioCount > limits.total) throw new VideoRequestError('Seedance 最多使用 9 张图片、3 个视频和 3 个音频；当前画布参考素材总数不能超过 12')
  const mode = input.videoMode && input.videoMode !== 'auto' ? input.videoMode : videoCount > 0 || audioCount > 0 || imageCount > 2 ? 'ref2va' : imageCount === 2 ? 'fl2va' : imageCount === 1 ? 'i2va' : 't2va'
  if (mode === 't2va' && imageCount + videoCount + audioCount !== 0) throw new VideoRequestError('Seedance 文生视频模式不接受参考素材')
  if (mode === 'i2va' && (imageCount !== 1 || videoCount + audioCount !== 0)) throw new VideoRequestError('Seedance 首帧模式需要且仅接受一张图片')
  if (mode === 'fl2va' && (imageCount !== 2 || videoCount + audioCount !== 0)) throw new VideoRequestError('Seedance 首尾帧模式需要且仅接受两张图片')
  if (mode === 'ref2va' && imageCount + videoCount === 0) throw new VideoRequestError('Seedance 多模态参考模式需要至少一张图片或一个视频，不能仅传音频')
  const sizeRatio = input.size && !['auto', '1280x720', '1280x736'].includes(input.size) ? videoAspectRatioFromSize(input.size) : undefined
  return { provider: 'seedance', protocolRevision: videoRequestProtocolRevision, videoProtocol: 'ark-seedance', body: { model: input.model, prompt: input.prompt, duration: Number(input.seconds ?? arkSeedanceVideoDefaults.seconds), mode, resolution: input.videoResolution ?? arkSeedanceVideoDefaults.resolution, aspect_ratio: input.videoAspectRatio ?? sizeRatio ?? arkSeedanceVideoDefaults.aspectRatio, execution_expires_after: arkSeedanceExecutionExpiresAfter, ...(input.generateAudio === undefined ? {} : { generate_audio: input.generateAudio }) } }
}

export function parseUpstreamVideoTaskId(value: unknown): string {
  if (typeof value !== 'string' || value.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) || value.includes('..')) throw new VideoRequestError('视频接口没有返回有效的任务编号，请核对原请求，不要再次提交', 502)
  return value
}

export interface VideoResultDescriptor { url?: string; expiresAt?: string | number; contentType?: string; sizeBytes?: number; sha256?: string }
export interface UpstreamVideoTask { taskId: string; state: 'pending' | 'ready' | 'failed'; progress?: number; descriptor?: VideoResultDescriptor }

export function parseUpstreamVideoTask(value: unknown, expectedTaskId?: string): UpstreamVideoTask {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new VideoRequestError('视频接口未返回可确认的任务信息', 502)
  const document = value as Record<string, unknown>
  const taskId = parseUpstreamVideoTaskId(document.id)
  if (expectedTaskId && taskId !== expectedTaskId) throw new VideoRequestError('视频接口返回的任务与原任务不一致，已停止处理', 502)
  const status = typeof document.status === 'string' ? document.status.toLowerCase() : ''
  if (!['queued', 'in_progress', 'processing', 'submitted', 'completed', 'failed', 'cancelled'].includes(status)) throw new VideoRequestError('视频接口返回了未识别的任务状态，请稍后核对原任务', 502)
  const progress = typeof document.progress === 'number' && Number.isFinite(document.progress) && document.progress >= 0 && document.progress <= 100 ? document.progress : undefined
  if (status === 'failed' || status === 'cancelled') return { taskId, state: 'failed' }
  if (status !== 'completed') return { taskId, state: 'pending', ...(progress === undefined ? {} : { progress }) }
  const descriptor: VideoResultDescriptor = {}
  if (document.url !== undefined) {
    if (typeof document.url !== 'string' || document.url.length > 8192 || /[\x00-\x1f\x7f]/.test(document.url)) throw new VideoRequestError('视频结果地址格式无法确认', 502)
    descriptor.url = document.url
  }
  const expiresAt = document.url_expires_at ?? document.asset_expires_at
  if (expiresAt !== undefined && expiresAt !== null) {
    if (typeof expiresAt !== 'string' && typeof expiresAt !== 'number') throw new VideoRequestError('视频结果有效期格式无法确认', 502)
    if (typeof expiresAt === 'string' && (expiresAt.length > 64 || !Number.isFinite(Date.parse(expiresAt)))) throw new VideoRequestError('视频结果有效期格式无法确认', 502)
    if (typeof expiresAt === 'number' && (!Number.isFinite(expiresAt) || expiresAt <= 0)) throw new VideoRequestError('视频结果有效期格式无法确认', 502)
    descriptor.expiresAt = expiresAt
  }
  if (document.content_type !== undefined) {
    if (typeof document.content_type !== 'string' || !['video/mp4', 'application/octet-stream'].includes(document.content_type.split(';', 1)[0].trim().toLowerCase())) throw new VideoRequestError('视频结果类型不是 MP4，已停止处理', 502)
    descriptor.contentType = document.content_type.split(';', 1)[0].trim().toLowerCase()
  }
  if (document.size_bytes !== undefined) {
    if (!Number.isSafeInteger(document.size_bytes) || Number(document.size_bytes) <= 0) throw new VideoRequestError('视频结果容量信息无法确认', 502)
    descriptor.sizeBytes = Number(document.size_bytes)
  }
  if (document.sha256 !== undefined) {
    if (typeof document.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(document.sha256)) throw new VideoRequestError('视频结果校验信息无法确认', 502)
    descriptor.sha256 = document.sha256.toLowerCase()
  }
  return { taskId, state: 'ready', descriptor, ...(progress === undefined ? {} : { progress }) }
}

interface IsoBox { type: string; start: number; end: number }
export interface GeneratedVideoInfo { mimeType: 'video/mp4'; width?: number; height?: number; durationSeconds?: number }

/** Read container metadata only; this does not claim to decode every video frame. */
export function generatedVideoInfo(bytes: Uint8Array, declaredMime?: string): GeneratedVideoInfo {
  if (bytes.byteLength > maximumGeneratedVideoBytes) throw new VideoRequestError('生成视频超过 32 MB，原任务已保留；不会重新生成', 413)
  const mime = declaredMime?.split(';', 1)[0].trim().toLowerCase()
  if (mime && mime !== 'video/mp4' && mime !== 'application/octet-stream') throw new VideoRequestError('视频下载类型不是 MP4，已停止保存', 502)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let budget = 0
  function ascii(start: number, length: number): string { return String.fromCharCode(...bytes.subarray(start, start + length)) }
  function boxes(start: number, end: number): IsoBox[] {
    const result: IsoBox[] = []
    let offset = start
    while (offset + 8 <= end) {
      if (++budget > 10_000) throw new VideoRequestError('视频容器结构超过安全上限', 502)
      const value = view.getUint32(offset)
      const large = value === 1
      const header = large ? 16 : 8
      if (offset + header > end) throw new VideoRequestError('视频容器结构不完整', 502)
      const extended = large ? view.getBigUint64(offset + 8) : BigInt(0)
      if (extended > BigInt(Number.MAX_SAFE_INTEGER)) throw new VideoRequestError('视频容器尺寸无法确认', 502)
      const size = large ? Number(extended) : value === 0 ? end - offset : value
      if (size < header || offset + size > end) throw new VideoRequestError('视频容器内容不完整或边界无效', 502)
      result.push({ type: ascii(offset + 4, 4), start: offset + header, end: offset + size })
      offset += size
    }
    if (offset !== end) throw new VideoRequestError('视频容器尾部内容不完整', 502)
    return result
  }
  function duration(box: IsoBox): number | undefined {
    const version = bytes[box.start]
    const scaleAt = version === 0 ? 12 : version === 1 ? 20 : -1
    if (scaleAt < 0 || box.start + scaleAt + (version === 0 ? 8 : 12) > box.end) return undefined
    const scale = view.getUint32(box.start + scaleAt)
    const ticks = version === 0 ? BigInt(view.getUint32(box.start + scaleAt + 4)) : view.getBigUint64(box.start + scaleAt + 4)
    if (ticks === (version === 0 ? BigInt('0xffffffff') : BigInt('0xffffffffffffffff'))) return undefined
    const seconds = Number(ticks) / scale
    return scale > 0 && Number.isFinite(seconds) && seconds > 0 && seconds <= 365 * 24 * 3600 ? Math.round(seconds * 1000) / 1000 : undefined
  }
  if (bytes.byteLength < 16 || ascii(4, 4) !== 'ftyp') throw new VideoRequestError('视频内容无效，仅支持 MP4', 502)
  const top = boxes(0, bytes.byteLength)
  const ftyp = top[0]
  if (ftyp.type !== 'ftyp' || ftyp.end - ftyp.start < 8) throw new VideoRequestError('视频容器格式无法确认', 502)
  const brands = new Set(['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'dash', 'M4V '])
  if (!brands.has(ascii(ftyp.start, 4))) throw new VideoRequestError('视频容器类型不是受支持的 MP4', 502)
  const moov = top.find((box) => box.type === 'moov')
  if (!moov || !top.some((box) => box.type === 'mdat' && box.end > box.start)) throw new VideoRequestError('视频容器缺少媒体数据或信息，已停止保存', 502)
  const children = boxes(moov.start, moov.end)
  let video: GeneratedVideoInfo | undefined
  for (const track of children.filter((box) => box.type === 'trak')) {
    const parts = boxes(track.start, track.end)
    const mdia = parts.find((box) => box.type === 'mdia')
    if (!mdia) continue
    const media = boxes(mdia.start, mdia.end)
    const handler = media.find((box) => box.type === 'hdlr')
    if (!handler || handler.start + 12 > handler.end || ascii(handler.start + 8, 4) !== 'vide') continue
    const tkhd = parts.find((box) => box.type === 'tkhd')
    const mdhd = media.find((box) => box.type === 'mdhd')
    video = { mimeType: 'video/mp4' }
    if (tkhd) {
      const offset = bytes[tkhd.start] === 0 ? 76 : bytes[tkhd.start] === 1 ? 88 : -1
      if (offset >= 0 && tkhd.start + offset + 8 <= tkhd.end) {
        const width = Math.round(view.getUint32(tkhd.start + offset) / 65536)
        const height = Math.round(view.getUint32(tkhd.start + offset + 4) / 65536)
        const matrix = tkhd.start + offset - 36
        const rotated = view.getInt32(matrix) === 0 && view.getInt32(matrix + 16) === 0 && Math.abs(view.getInt32(matrix + 4)) === 65536 && Math.abs(view.getInt32(matrix + 12)) === 65536
        if (width > 0 && height > 0 && width <= 65535 && height <= 65535) { video.width = rotated ? height : width; video.height = rotated ? width : height }
      }
    }
    const movieHeader = children.find((box) => box.type === 'mvhd')
    const seconds = mdhd && duration(mdhd) || movieHeader && duration(movieHeader)
    if (seconds) video.durationSeconds = seconds
    break
  }
  if (!video) throw new VideoRequestError('MP4 中未确认视频轨道，已停止保存', 502)
  return video
}

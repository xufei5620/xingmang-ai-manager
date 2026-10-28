// 测试用的宿主声明：内核能做的全都打开，用来给只想测别的行为、不想被宿主能力挡住的测试（#4）。
import { builtinNodeDefinitions } from './domain/builtin-node-definitions'
import { KERNEL_CONTRACT_VERSION, resolveCanvasCapabilities, type CanvasHostCapabilities } from './host-capabilities'
import { videoAspectRatioOptions, videoResolutionOptions, videoSizeOptions } from './models'

export const fullCanvasCapabilities: CanvasHostCapabilities = {
  contractVersion: KERNEL_CONTRACT_VERSION,
  host: 'web',
  executableNodeKinds: builtinNodeDefinitions.filter((definition) => definition.executable && definition.type !== 'unknown').map((definition) => definition.type),
  features: {
    quote: true, accountSummary: true, imageEditMask: true, textGenerate: true, textWebSearch: true, imageTools: true,
    frameExtract: true, scenarioTemplates: true, routerStrategy: true, generateAudio: true, referenceOrder: true,
    cloud: true, agentExecution: true, byteUpload: true, promptPresetGroups: true, fileDownload: true, clipboardRead: true,
  },
  imageCandidates: { maximum: 4 },
  videoCandidates: { maximum: 4 },
  promptPresetNameMaxLength: 160,
  imageResolutions: { byModel: {}, otherGptImage: ['1K', '2K', '4K'], otherModels: ['1K', '2K', '4K'], kernelRequestSizes: true },
  video: {
    protocols: ['relay-videos', 'xai-native', 'ark-seedance'],
    seconds: { minimum: 1, maximum: 15 },
    dimensions: videoSizeOptions.map((option) => option.value),
    miniMaxResolutions: videoResolutionOptions.map((option) => option.value),
    miniMaxAspectRatios: videoAspectRatioOptions.map((option) => option.value),
  },
}

export const fullCanvasCapabilityProfile = resolveCanvasCapabilities(fullCanvasCapabilities)

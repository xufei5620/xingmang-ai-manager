// 图片分辨率按宿主声明（#4）：每个图片模型能选哪些分辨率由宿主声明，内核只提供声明里有的。2K、4K 的实际像素
// 由真正发请求的一方换算：网页服务端用的就是内核的请求构建器（image-request-parameters.ts），内核照它核对、
// 也能说出会发多大；桌面主进程自己换算（v2 时代 Gemini 也有 2K/4K，GPT Image 2 的 4K 档和这里不一样），
// 内核不替它猜像素，只核对 1K 时两边一样的尺寸、画质这些参数，其余交给宿主付费前自己校验。
import { canvasImageModelResolutions, type CanvasCapabilityProfile } from '../host-capabilities'
import { imageModelPreset } from '../models'
import { buildImageRequestParameters, ImageRequestParameterError, type ImageRequestParametersInput } from './image-request-parameters'

export interface HostImageRequestCheck {
  /** The size the request carries, when the kernel builds that request itself. */
  size?: string
  /** The host works out this resolution's pixels itself, so the kernel names none. */
  hostSized?: true
}

/**
 * Refuses an image request this host would refuse. Without a profile it is
 * the kernel's own request builder, exactly as the web server runs it.
 */
export function assertHostImageRequest(input: ImageRequestParametersInput, capabilities?: CanvasCapabilityProfile): HostImageRequestCheck {
  const resolution = input.imageResolution ?? '1K'
  const kernelSized = !capabilities || capabilities.imageResolutions.kernelRequestSizes
  // The builder's own refusal comes first so a web host, whose declaration is
  // what the builder accepts, keeps every message it had.
  const parameters = buildImageRequestParameters(kernelSized ? input : { ...input, imageResolution: '1K' })
  if (capabilities && !canvasImageModelResolutions(input.model, capabilities).includes(resolution)) {
    throw new ImageRequestParameterError(`模型「${imageModelPreset(input.model.trim()).label}」不支持 ${resolution} 清晰度`)
  }
  if (!kernelSized && resolution !== '1K') return { hostSized: true }
  return typeof parameters.size === 'string' ? { size: parameters.size } : {}
}

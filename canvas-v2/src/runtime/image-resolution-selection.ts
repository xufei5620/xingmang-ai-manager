import type { CanvasCapabilityProfile } from '../host-capabilities'
import { assertHostImageRequest } from './host-image-request'
import { imageRequestModelControls, type ImageRequestResolution } from './image-request-parameters'

export interface ImageResolutionChoice {
  value: ImageRequestResolution
  supported: boolean
  effectiveSize?: string
  /** The host works out this resolution's pixel size itself. */
  hostSized?: true
  reason: string | null
}

export interface ImageResolutionSelection {
  value: ImageRequestResolution
  supported: boolean
  choices: readonly ImageResolutionChoice[]
  effectiveSize?: string
  providerSized?: boolean
  hostSized?: true
  message: string | null
}

const resolutions: readonly ImageRequestResolution[] = ['1K', '2K', '4K']

/**
 * Preserve the saved value even when a model or ratio change invalidates it.
 * With a host profile, only the resolutions the host declares are offered.
 */
export function inspectImageResolutionSelection(input: { model: string; size?: string; imageResolution?: ImageRequestResolution }, capabilities?: CanvasCapabilityProfile): ImageResolutionSelection {
  const value = input.imageResolution ?? '1K'
  const providerSized = !imageRequestModelControls(input.model).supportsSize
  const choices = resolutions.map((resolution): ImageResolutionChoice => {
    try {
      const request = assertHostImageRequest({ model: input.model, size: input.size, imageResolution: resolution, prompt: '尺寸校验' }, capabilities)
      return { value: resolution, supported: true, ...(request.size ? { effectiveSize: request.size } : {}), ...(request.hostSized ? { hostSized: true } : {}), reason: null }
    } catch (error) {
      return { value: resolution, supported: false, reason: error instanceof Error ? error.message : '当前模型与尺寸不支持这个分辨率' }
    }
  })
  const selected = choices.find((choice) => choice.value === value)!
  return {
    value, supported: selected.supported, choices, ...(providerSized ? { providerSized: true } : {}),
    ...(selected.effectiveSize ? { effectiveSize: selected.effectiveSize } : {}), ...(selected.hostSized ? { hostSized: true } : {}),
    message: !selected.supported ? `保留的 ${value} 当前不可用：${selected.reason}。请更换分辨率、比例或模型。`
      : providerSized ? '当前接入方式由服务决定输出尺寸；保存的比例不会作为尺寸参数发送。' : null,
  }
}

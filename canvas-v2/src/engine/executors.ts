import type { AssetRef, NodeKind } from '../model'
import {
  defaultImageQuality,
  defaultImageSize,
  defaultVideoModel,
  defaultVideoSize,
  parseImageSize,
  normalizeVideoSeconds,
  imageModelPreset,
  validateImageModelOptions,
  validateVideoModelOptions,
} from '../models'
import type { CanvasHostBridge } from '../host'
import type { NodeExecutor } from './engine'

export interface HostExecutorOptions {
  imageGroup: string
  videoGroup: string
  host: Pick<CanvasHostBridge, 'generateImage' | 'editImage' | 'generateVideo' | 'cancelRequest'>
}

let requestSequence = 0

function nextRequestId(nodeId: string): string {
  requestSequence += 1
  return `${nodeId}-${Date.now().toString(36)}-${requestSequence.toString(36)}`
}

function combinedPrompt(upstreamText: string | undefined, ownPrompt: string): string {
  return [upstreamText, ownPrompt].filter((part) => part && part.trim()).join('\n')
}

function toAssetRef(asset: Awaited<ReturnType<CanvasHostBridge['generateImage']>>[number]): AssetRef {
  return {
    kind: 'image',
    assetId: asset.assetId,
    localUrl: asset.localUrl,
    mimeType: asset.mimeType,
    ...(asset.width ? { width: asset.width } : {}),
    ...(asset.height ? { height: asset.height } : {}),
  }
}

function toVideoAssetRef(asset: Awaited<ReturnType<CanvasHostBridge['generateVideo']>>): AssetRef {
  return {
    kind: 'video',
    assetId: asset.assetId,
    localUrl: asset.localUrl,
    mimeType: asset.mimeType,
    taskId: asset.taskId,
    ...(asset.width ? { width: asset.width } : {}),
    ...(asset.height ? { height: asset.height } : {}),
  }
}

export function createHostExecutors(options: HostExecutorOptions): Record<NodeKind, NodeExecutor> {
  const text: NodeExecutor = async (node) => ({ output: { text: node.data.prompt } })

  const image: NodeExecutor = async (node, inputs, signal) => {
      if (!options.imageGroup) throw new Error('请先在「生成配置」中选择生图分组')
      const prompt = combinedPrompt(inputs.text, node.data.prompt)
      if (!prompt) throw new Error('请输入图像提示词或连接上游文本节点')
      const model = node.data.model.trim()
      if (!model) throw new Error('请选择图像模型')
      const preset = imageModelPreset(model)
      const errors = validateImageModelOptions({
        model,
        operation: 'generate',
        size: preset.supportsSize ? (node.data.size || defaultImageSize) : undefined,
        quality: preset.supportsQuality ? (node.data.quality || defaultImageQuality) : undefined,
      })
      if (errors[0]) throw new Error(errors[0])
      const requestId = nextRequestId(node.id)
      const cancel = () => { void options.host.cancelRequest(requestId).catch(() => undefined) }
      signal.addEventListener('abort', cancel, { once: true })
      try {
        if (signal.aborted) throw new Error('已取消')
        const assets = await options.host.generateImage({
          requestId,
          group: options.imageGroup,
          model,
          prompt,
          size: preset.supportsSize ? (node.data.size || defaultImageSize) : undefined,
          quality: preset.supportsQuality
            ? (node.data.quality || defaultImageQuality) as 'low' | 'medium' | 'high' | 'auto'
            : undefined,
        })
        if (signal.aborted) throw new Error('已取消')
        if (!assets[0]) throw new Error('生图接口没有返回图片')
        return { output: { asset: toAssetRef(assets[0]) } }
      } finally {
        signal.removeEventListener('abort', cancel)
      }
    }

  const imageEdit: NodeExecutor = async (node, inputs, signal) => {
    if (!options.imageGroup) throw new Error('请先在「生成配置」中选择生图分组')
    const prompt = combinedPrompt(inputs.text, node.data.prompt)
    if (!prompt) throw new Error('请输入图片编辑指令或连接上游文本节点')
    const sourceAssetIds = [...new Set(
      (inputs.images ?? (inputs.image ? [inputs.image] : []))
        .map((asset) => asset.assetId)
        .filter((assetId): assetId is string => Boolean(assetId)),
    )]
    if (sourceAssetIds.length === 0) throw new Error('请连接至少一张已保存到本地资产库的参考图片')
    if (sourceAssetIds.length > 4) throw new Error('图片编辑最多支持 4 张参考图片')
    const model = node.data.model.trim()
    if (!model) throw new Error('请选择图像模型')
    const preset = imageModelPreset(model)
    const errors = validateImageModelOptions({
      model,
      operation: 'edit',
      size: preset.supportsSize ? (node.data.size || defaultImageSize) : undefined,
      quality: preset.supportsQuality ? (node.data.quality || defaultImageQuality) : undefined,
      referenceImageCount: sourceAssetIds.length,
    })
    if (errors[0]) throw new Error(errors[0])
    const requestId = nextRequestId(node.id)
    const cancel = () => { void options.host.cancelRequest(requestId).catch(() => undefined) }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      if (signal.aborted) throw new Error('已取消')
      const assets = await options.host.editImage({
        requestId,
        group: options.imageGroup,
        model,
        prompt,
        sourceAssetIds,
        size: preset.supportsSize ? (node.data.size || defaultImageSize) : undefined,
        quality: preset.supportsQuality
          ? (node.data.quality || defaultImageQuality) as 'low' | 'medium' | 'high' | 'auto'
          : undefined,
      })
      if (signal.aborted) throw new Error('已取消')
      if (!assets[0]) throw new Error('图片编辑接口没有返回图片')
      return { output: { asset: toAssetRef(assets[0]) } }
    } finally {
      signal.removeEventListener('abort', cancel)
    }
  }

  const video: NodeExecutor = async (node, inputs, signal) => {
    if (!options.videoGroup) throw new Error('请先在「生成配置」中选择视频分组')
    const prompt = combinedPrompt(inputs.text, node.data.prompt)
    if (!prompt) throw new Error('请输入视频提示词或连接上游文本节点')
    const model = node.data.model.trim() || defaultVideoModel
    const secondsValue = node.data.seconds ?? node.data.settings?.seconds ?? node.data.settings?.durationSeconds
    const seconds = normalizeVideoSeconds(secondsValue, model)
    const videoSize = typeof node.data.size === 'string' ? node.data.size : defaultVideoSize
    const dimensions = parseImageSize(videoSize)
    const imageAssetId = inputs.images?.[0]?.assetId ?? inputs.image?.assetId
    const errors = validateVideoModelOptions({ model, seconds: secondsValue, size: videoSize, hasImage: Boolean(imageAssetId) })
    if (errors[0]) throw new Error(errors[0])
    if (!seconds) throw new Error('视频时长必须是 1-15 秒之间的整数')
    if (!dimensions) throw new Error('视频比例格式错误')
    if (inputs.image && !imageAssetId) throw new Error('图生视频需要连接已保存到本地资产库的参考图片')
    const requestId = nextRequestId(node.id)
    const cancel = () => { void options.host.cancelRequest(requestId).catch(() => undefined) }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      if (signal.aborted) throw new Error('已取消')
      const asset = await options.host.generateVideo({
        requestId,
        group: options.videoGroup,
        model,
        prompt,
        seconds,
        width: dimensions.width,
        height: dimensions.height,
        ...(imageAssetId ? { imageAssetId } : {}),
      })
      if (signal.aborted) throw new Error('已取消；服务端任务可能仍在继续，可稍后从运行记录续查')
      return { output: { asset: toVideoAssetRef(asset) } }
    } finally {
      signal.removeEventListener('abort', cancel)
    }
  }
  const unsupported: NodeExecutor = async () => { throw new Error('当前节点能力尚未接入，请勿提交付费请求') }
  return {
    text, image, video, prompt: text,
    'image-input': unsupported, 'video-input': unsupported, 'audio-input': unsupported,
    'image-generate': image, 'image-edit': imageEdit, 'video-generate': video,
    'frame-extract': unsupported, router: unsupported, gallery: unsupported, output: unsupported,
    group: unsupported, note: unsupported,
    unknown: unsupported,
  }
}

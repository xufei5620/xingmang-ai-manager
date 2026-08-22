import type { AssetRef, NodeKind } from '../model'
import {
  defaultImageQuality,
  defaultImageResolution,
  defaultImageSize,
  defaultVideoModel,
  defaultVideoSize,
  parseImageSize,
  normalizeVideoSeconds,
  resolveMiniMaxVideoMode,
  imageModelPreset,
  validateImageModelOptions,
  validateVideoModelOptions,
  videoModelPreset,
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

function sourceImageAssetIds(inputs: { image?: AssetRef; images?: readonly AssetRef[] }): string[] {
  return [...new Set(
    (inputs.images ?? (inputs.image ? [inputs.image] : []))
      .map((asset) => asset.assetId)
      .filter((assetId): assetId is string => Boolean(assetId)),
  )]
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
        imageResolution: node.data.imageResolution || defaultImageResolution,
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
          imageResolution: node.data.imageResolution || defaultImageResolution,
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
      imageResolution: node.data.imageResolution || defaultImageResolution,
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
        imageResolution: node.data.imageResolution || defaultImageResolution,
      })
      if (signal.aborted) throw new Error('已取消')
      if (!assets[0]) throw new Error('图片编辑接口没有返回图片')
      return { output: { asset: toAssetRef(assets[0]) } }
    } finally {
      signal.removeEventListener('abort', cancel)
    }
  }

  const imageOrEdit: NodeExecutor = async (node, inputs, signal) => {
    return sourceImageAssetIds(inputs).length > 0
      ? imageEdit(node, inputs, signal)
      : image(node, inputs, signal)
  }

  const video: NodeExecutor = async (node, inputs, signal) => {
    if (!options.videoGroup) throw new Error('请先在「生成配置」中选择视频分组')
    const prompt = combinedPrompt(inputs.text, node.data.prompt)
    if (!prompt) throw new Error('请输入视频提示词或连接上游文本节点')
    const model = node.data.model.trim() || defaultVideoModel
    const preset = videoModelPreset(model)
    const secondsValue = node.data.seconds ?? node.data.settings?.seconds ?? node.data.settings?.durationSeconds
    const seconds = normalizeVideoSeconds(secondsValue, model)
    const videoSize = typeof node.data.size === 'string' ? node.data.size : defaultVideoSize
    const images = inputs.images ?? (inputs.image ? [inputs.image] : [])
    const videos = inputs.videos ?? (inputs.video ? [inputs.video] : [])
    const audios = inputs.audios ?? (inputs.audio ? [inputs.audio] : [])
    const assetIds = (entries: typeof images, label: string) => {
      const ids = [...new Set(entries.flatMap((asset) => asset.assetId ? [asset.assetId] : []))]
      if (ids.length !== entries.length) throw new Error(`${label}需要连接已保存到本地资产库的素材`)
      return ids
    }
    const imageAssetIds = assetIds(images, '视频参考图片')
    const videoAssetIds = assetIds(videos, '视频参考视频')
    const audioAssetIds = assetIds(audios, '视频参考音频')
    const requestedMode = typeof node.data.settings?.videoMode === 'string' ? node.data.settings.videoMode : 'auto'
    const mode = preset.provider === 'minimax-h3'
      ? resolveMiniMaxVideoMode({
        mode: requestedMode,
        imageCount: imageAssetIds.length,
        videoCount: videoAssetIds.length,
        audioCount: audioAssetIds.length,
      })
      : null
    const resolution = typeof node.data.settings?.videoResolution === 'string' ? node.data.settings.videoResolution : '720p'
    const aspectRatio = typeof node.data.settings?.videoAspectRatio === 'string' ? node.data.settings.videoAspectRatio : '16:9'
    const errors = validateVideoModelOptions({
      model,
      seconds: secondsValue,
      ...(preset.provider === 'grok' ? { size: videoSize } : {}),
      mode: requestedMode,
      resolution,
      aspectRatio,
      imageCount: imageAssetIds.length,
      videoCount: videoAssetIds.length,
      audioCount: audioAssetIds.length,
    })
    if (errors[0]) throw new Error(errors[0])
    if (!seconds) throw new Error(`视频时长必须是 ${preset.minimumSeconds}-${preset.maximumSeconds} 秒之间的整数`)
    const dimensions = preset.provider === 'grok' ? parseImageSize(videoSize) : null
    if (preset.provider === 'grok' && !dimensions) throw new Error('视频比例格式错误')
    if (preset.provider === 'minimax-h3' && !mode) throw new Error('MiniMax 生成模式无效')
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
          ...(preset.provider === 'grok' && dimensions ? {
            width: dimensions.width,
            height: dimensions.height,
            ...(imageAssetIds[0] ? { imageAssetId: imageAssetIds[0] } : {}),
            ...(imageAssetIds.length > 1 ? { imageAssetIds } : {}),
            ...(videoAssetIds.length > 0 ? { videoAssetIds } : {}),
            ...(audioAssetIds.length > 0 ? { audioAssetIds } : {}),
          } : {
            mode: mode!,
            resolution: resolution as '480p' | '720p',
            aspectRatio: aspectRatio as '16:9' | '9:16' | '1:1' | '4:3' | '3:4' | '21:9' | '9:21' | '4:5' | '5:4',
            promptOptimization: node.data.settings?.promptOptimization === true,
            ...(imageAssetIds.length > 0 ? { imageAssetIds } : {}),
            ...(videoAssetIds.length > 0 ? { videoAssetIds } : {}),
            ...(audioAssetIds.length > 0 ? { audioAssetIds } : {}),
          }),
        })
      if (signal.aborted) throw new Error('已取消；服务端任务可能仍在继续，可稍后从运行记录续查')
      return { output: { asset: toVideoAssetRef(asset) } }
    } finally {
      signal.removeEventListener('abort', cancel)
    }
  }
  const unsupported: NodeExecutor = async () => { throw new Error('当前节点能力尚未接入，请勿提交付费请求') }
  return {
    text, video, prompt: text,
    'image-input': unsupported, 'video-input': unsupported, 'audio-input': unsupported,
    image: imageOrEdit, 'image-generate': imageOrEdit, 'image-edit': imageEdit, 'video-generate': video,
    'frame-extract': unsupported, router: unsupported, gallery: unsupported, output: unsupported,
    group: unsupported, note: unsupported,
    unknown: unsupported,
    'drama-bible': text, 'drama-script': text, 'drama-parse': text, 'drama-shot': text,
    'drama-character': unsupported, 'drama-scene': unsupported, 'drama-prop': unsupported,
  }
}

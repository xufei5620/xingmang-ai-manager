import type { AssetRef, NodeKind } from '../model'
import { defaultImageQuality, defaultImageSize, imageModelPreset } from '../models'
import type { CanvasHostBridge } from '../host'
import type { NodeExecutor } from './engine'

export interface HostExecutorOptions {
  group: string
  host: Pick<CanvasHostBridge, 'generateImage' | 'editImage' | 'cancelRequest'>
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

export function createHostExecutors(options: HostExecutorOptions): Record<NodeKind, NodeExecutor> {
  const text: NodeExecutor = async (node) => ({ output: { text: node.data.prompt } })

  const image: NodeExecutor = async (node, inputs, signal) => {
      const prompt = combinedPrompt(inputs.text, node.data.prompt)
      if (!prompt) throw new Error('请输入图像提示词或连接上游文本节点')
      const model = node.data.model.trim()
      if (!model) throw new Error('请选择图像模型')
      const preset = imageModelPreset(model)
      const requestId = nextRequestId(node.id)
      const cancel = () => { void options.host.cancelRequest(requestId).catch(() => undefined) }
      signal.addEventListener('abort', cancel, { once: true })
      try {
        if (signal.aborted) throw new Error('已取消')
        const assets = await options.host.generateImage({
          requestId,
          group: options.group,
          model,
          prompt,
          size: node.data.size || defaultImageSize,
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
    const requestId = nextRequestId(node.id)
    const cancel = () => { void options.host.cancelRequest(requestId).catch(() => undefined) }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      if (signal.aborted) throw new Error('已取消')
      const assets = await options.host.editImage({
        requestId,
        group: options.group,
        model,
        prompt,
        sourceAssetIds,
        size: node.data.size || defaultImageSize,
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

  const video: NodeExecutor = async () => {
    throw new Error('当前版本的视频生成正在迁移到安全宿主通道，请先使用图像工作流')
  }
  const unsupported: NodeExecutor = async () => { throw new Error('当前节点能力尚未接入，请勿提交付费请求') }
  return {
    text, image, video, prompt: text,
    'image-input': unsupported, 'video-input': unsupported,
    'image-generate': image, 'image-edit': imageEdit, 'video-generate': video,
    'frame-extract': unsupported, router: unsupported, gallery: unsupported, output: unsupported,
    group: unsupported, note: unsupported,
    unknown: unsupported,
  }
}

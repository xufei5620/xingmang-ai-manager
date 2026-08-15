import type { AiImageEditInput, AiImageGenerationInput, AiImageService } from './ai-image-service'
import { resolveAiModelCapability } from './ai-chat-protocol'
import type { AiVideoGenerationInput, AiVideoService } from './ai-video-service'
import type {
  CanvasNodeExecutionResult,
  CanvasNodeExecutors,
} from './canvas-run-engine'

export interface CanvasImageOperationService {
  generate(senderId: number, input: AiImageGenerationInput): ReturnType<AiImageService['generate']>
  edit?(senderId: number, input: AiImageEditInput): ReturnType<AiImageService['edit']>
  cancel(senderId: number, requestId: string): ReturnType<AiImageService['cancel']>
}

export interface CanvasOwnedAssetService {
  readOwned(userId: number, assetId: string, kind?: 'image' | 'video' | 'audio'): Promise<{ asset: {
    assetId: string
    localUrl: string
    mimeType?: string
    width?: number
    height?: number
  } }>
}

export interface CanvasVideoOperationService {
  generate(senderId: number, input: AiVideoGenerationInput): ReturnType<AiVideoService['generate']>
  cancel(senderId: number, requestId: string): ReturnType<AiVideoService['cancel']>
}

function promptForNode(localPrompt: string, upstreamPrompt: string | undefined): string {
  return [upstreamPrompt, localPrompt].filter(Boolean).join('\n').trim()
}

function videoDimensions(size: string | undefined): { width: number; height: number } {
  const normalized = size || '1280x720'
  const allowed = new Set(['1280x720', '720x1280', '1024x1024', '1024x768', '768x1024'])
  if (!allowed.has(normalized)) throw new Error('视频比例不受支持')
  const [width, height] = normalized.split('x').map(Number)
  return { width, height }
}

function imageResult(
  assets: Awaited<ReturnType<AiImageService['generate']>>,
  group: string,
  model: string,
): CanvasNodeExecutionResult {
  return {
    assets: assets.map((asset) => ({
      kind: 'image' as const,
      assetId: asset.assetId,
      localUrl: asset.localUrl,
      mimeType: asset.mimeType,
      ...(asset.width ? { width: asset.width } : {}),
      ...(asset.height ? { height: asset.height } : {}),
    })),
    group,
    model,
  }
}

export function createCanvasNodeExecutors(options: {
  imageService: CanvasImageOperationService
  videoService?: CanvasVideoOperationService
  assets?: CanvasOwnedAssetService
  imageGroup?: string
  videoGroup?: string
}): CanvasNodeExecutors {
  const text: CanvasNodeExecutors['text'] = async ({ node }) => ({ outputText: node.data.prompt })
  const image: CanvasNodeExecutors['image'] = async ({ ownerId, userId, projectId, attemptId, node, inputs, signal }) => {
    const prompt = promptForNode(node.data.prompt, inputs.text)
    if (!prompt) throw new Error('请输入图像提示词或连接上游文本节点')
    const group = node.data.group || options.imageGroup || '生图分组'
    const requestId = `canvas-run:${attemptId}`
    const onAbort = () => { options.imageService.cancel(ownerId, requestId) }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      return imageResult(await options.imageService.generate(ownerId, {
        requestId,
        group,
        model: node.data.model,
        prompt,
        expectedUserId: userId,
        projectId,
        ...(node.data.size ? { size: node.data.size } : {}),
        ...(node.data.quality === 'low'
          || node.data.quality === 'medium'
          || node.data.quality === 'high'
          || node.data.quality === 'auto'
          ? { quality: node.data.quality }
          : {}),
      }), group, node.data.model)
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }
  const imageEdit: CanvasNodeExecutors['image-edit'] = async ({ ownerId, userId, projectId, attemptId, node, inputs, signal }) => {
    if (!options.imageService.edit) throw new Error('图片编辑能力尚未接入，当前不会提交付费请求')
    const prompt = promptForNode(node.data.prompt, inputs.text)
    if (!prompt) throw new Error('请输入图片编辑指令或连接上游文本节点')
    const capability = resolveAiModelCapability(node.data.model)
    if (capability.kind !== 'image' || !capability.supportsEdits) {
      throw new Error('当前模型不支持图片编辑，请换用支持编辑的图像模型')
    }
    const sourceAssetIds = [...new Set(
      (inputs.images ?? (inputs.image ? [inputs.image] : []))
        .flatMap((asset) => asset.assetId ? [asset.assetId] : []),
    )]
    if (sourceAssetIds.length === 0) throw new Error('请连接至少一张已保存到本地资产库的参考图片')
    if (sourceAssetIds.length > 4) throw new Error('图片编辑最多支持 4 张参考图片')
    const group = node.data.group || options.imageGroup || '生图分组'
    const requestId = `canvas-run:${attemptId}`
    const onAbort = () => { options.imageService.cancel(ownerId, requestId) }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      return imageResult(await options.imageService.edit(ownerId, {
        requestId,
        group,
        model: node.data.model,
        prompt,
        sourceAssetIds,
        expectedUserId: userId,
        projectId,
        ...(node.data.size ? { size: node.data.size } : {}),
        ...(node.data.quality === 'low'
          || node.data.quality === 'medium'
          || node.data.quality === 'high'
          || node.data.quality === 'auto'
          ? { quality: node.data.quality }
          : {}),
      }), group, node.data.model)
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }
  const passThrough: CanvasNodeExecutors['gallery'] = async ({ inputs }) => ({
    ...(inputs.text !== undefined ? { outputText: inputs.text } : {}),
    ...(inputs.image ? { assets: [inputs.image] } : {}),
    ...(!inputs.image && inputs.video ? { assets: [inputs.video] } : {}),
    ...(!inputs.image && !inputs.video && inputs.audio ? { assets: [inputs.audio] } : {}),
  })
  const imageInput: CanvasNodeExecutors['image-input'] = async ({ userId, node, inputs }) => {
    if (inputs.image) return { assets: [inputs.image] }
    const assetId = node.data.adoptedAssetId
    if (!assetId || !options.assets) throw new Error('请从本地资产栏拖入一张图片')
    const owned = await options.assets.readOwned(userId, assetId)
    return { assets: [{ kind: 'image', ...owned.asset }] }
  }
  const videoInput: CanvasNodeExecutors['video-input'] = async ({ userId, node, inputs }) => {
    if (inputs.video) return { assets: [inputs.video] }
    const assetId = node.data.adoptedAssetId
    if (!assetId || !options.assets) throw new Error('请从本地资产栏拖入一个视频')
    const owned = await options.assets.readOwned(userId, assetId, 'video')
    return { assets: [{ kind: 'video', ...owned.asset }] }
  }
  const audioInput: CanvasNodeExecutors['audio-input'] = async ({ userId, node, inputs }) => {
    if (inputs.audio) return { assets: [inputs.audio] }
    const assetId = node.data.adoptedAssetId
    if (!assetId || !options.assets) throw new Error('请从本地资产栏拖入一个音频')
    const owned = await options.assets.readOwned(userId, assetId, 'audio')
    return { assets: [{ kind: 'audio', ...owned.asset }] }
  }
  const video: CanvasNodeExecutors['video'] = async ({ ownerId, userId, projectId, attemptId, node, inputs, signal }) => {
    if (!options.videoService) throw new Error('视频生成能力尚未接入，当前不会提交付费请求')
    const prompt = promptForNode(node.data.prompt, inputs.text)
    if (!prompt) throw new Error('请输入视频提示词或连接上游文本节点')
    const group = node.data.group || options.videoGroup
    if (!group) throw new Error('视频节点缺少生成分组，已在付费请求前停止')
    const requestId = `canvas-run:${attemptId}`
    const dimensions = videoDimensions(node.data.size)
    const imageAssetId = inputs.images?.[0]?.assetId ?? inputs.image?.assetId
    const onAbort = () => { options.videoService?.cancel(ownerId, requestId) }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      const asset = await options.videoService.generate(ownerId, {
        requestId,
        group,
        model: node.data.model,
        prompt,
        seconds: node.data.seconds ?? '5',
        ...dimensions,
        expectedUserId: userId,
        projectId,
        ...(imageAssetId ? { imageAssetId } : {}),
      })
      return {
        assets: [{
          kind: 'video', assetId: asset.assetId, localUrl: asset.localUrl,
          mimeType: asset.mimeType, taskId: asset.taskId,
          ...(asset.width ? { width: asset.width } : {}),
          ...(asset.height ? { height: asset.height } : {}),
        }],
        group,
        model: node.data.model,
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }
  const unsupported: CanvasNodeExecutors['image-edit'] = async () => {
    throw new Error('该节点能力尚未接入，当前不会提交付费请求')
  }
  return {
    text, prompt: text, image, 'image-generate': image,
    video, 'video-generate': video, 'image-edit': imageEdit,
    'frame-extract': unsupported, 'video-input': videoInput,
    'image-input': imageInput, 'audio-input': audioInput, router: passThrough, gallery: passThrough, output: passThrough,
    group: passThrough, note: text,
  }
}

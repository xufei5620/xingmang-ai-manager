import type { AiImageEditInput, AiImageGenerationInput, AiImageService } from './ai-image-service'
import { resolveAiModelCapability } from './ai-chat-protocol'
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
  readOwned(userId: number, assetId: string): Promise<{ asset: {
    assetId: string
    localUrl: string
    mimeType?: string
    width?: number
    height?: number
  } }>
}

function promptForNode(localPrompt: string, upstreamPrompt: string | undefined): string {
  return [upstreamPrompt, localPrompt].filter(Boolean).join('\n').trim()
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
  assets?: CanvasOwnedAssetService
  imageGroup?: string
}): CanvasNodeExecutors {
  const text: CanvasNodeExecutors['text'] = async ({ node }) => ({ outputText: node.data.prompt })
  const image: CanvasNodeExecutors['image'] = async ({ ownerId, attemptId, node, inputs, signal }) => {
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
  const imageEdit: CanvasNodeExecutors['image-edit'] = async ({ ownerId, userId, attemptId, node, inputs, signal }) => {
    if (!options.imageService.edit) throw new Error('图片编辑能力尚未接入，当前不会提交付费请求')
    const prompt = promptForNode(node.data.prompt, inputs.text)
    if (!prompt) throw new Error('请输入图片编辑指令或连接上游文本节点')
    const capability = resolveAiModelCapability(node.data.model)
    if (capability.kind !== 'image' || capability.provider !== 'gpt-image') {
      throw new Error('当前模型不支持图片编辑，请换用 GPT Image 系列')
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
  })
  const imageInput: CanvasNodeExecutors['image-input'] = async ({ userId, node, inputs }) => {
    if (inputs.image) return { assets: [inputs.image] }
    const assetId = node.data.adoptedAssetId
    if (!assetId || !options.assets) throw new Error('请从本地资产栏拖入一张图片')
    const owned = await options.assets.readOwned(userId, assetId)
    return { assets: [{ kind: 'image', ...owned.asset }] }
  }
  const unsupported: CanvasNodeExecutors['image-edit'] = async () => {
    throw new Error('该节点能力尚未接入，当前不会提交付费请求')
  }
  return {
    text, prompt: text, image, 'image-generate': image,
    video: unsupported, 'video-generate': unsupported, 'image-edit': imageEdit,
    'frame-extract': unsupported, 'video-input': unsupported,
    'image-input': imageInput, router: passThrough, gallery: passThrough, output: passThrough,
    group: passThrough, note: text,
  }
}

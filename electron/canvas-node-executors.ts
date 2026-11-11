import type { AiImageEditInput, AiImageGenerationInput, AiImageService } from './ai-image-service'
import { resolveAiModelCapability, type MiniMaxVideoMode } from './ai-chat-protocol'
import type { AiVideoGenerationInput, AiVideoService } from './ai-video-service'
import { assertCanvasImageEditMaskInput, buildCanvasImageMaskPng } from './canvas-image-mask'
import { assertCanvasTextImageInput } from './canvas-text-image-input'
import type { CanvasFrameExtraction, CanvasImageToolProcessing } from './canvas-run-preparations'
import {
  canvasImageTransformKindForNode,
  canvasImageTransformProcessorRevision,
  maximumCanvasImageTransformInputs,
  orderCanvasCollageSources,
  parseCanvasImageTransformRecipe,
  selectCanvasTileSource,
} from './canvas-image-tools'
import { canvasRunImageToolNodeLabels, type CanvasImagePreparation, type CanvasRunAsset } from './canvas-run-contract'
import type {
  CanvasNodeExecutionContext,
  CanvasNodeExecutionResult,
  CanvasNodeExecutors,
} from './canvas-run-engine'
import type { AiOperationProgressObserver, AiOperationProgressUpdate, AiRelayBillingObserver } from './ai-operation-progress'
import { parseDramaTablesJson } from './drama-parse'
import { dramaParseSystemPrompt } from './drama-parse-prompt'

export interface CanvasTextCompletionInput {
  group: string
  model: string
  /** Left out for a text-generate node: the user's own words are the whole request. */
  system?: string
  user: string
  /**
   * Pictures the model reads with the user message (画布完善第 6 条): canvas
   * asset ids, read from the account's own store only once the credential
   * names that account.
   */
  images?: { assetIds: readonly string[]; projectId?: string }
  signal: AbortSignal
  /** The attempt's 实扣 bookkeeping; hand it to the request. */
  billing?: AiRelayBillingObserver
}

export interface CanvasTextCompletionService {
  completeOnce(input: CanvasTextCompletionInput): Promise<string>
}

export interface CanvasImageOperationService {
  generate(senderId: number, input: AiImageGenerationInput, progress?: AiOperationProgressObserver): ReturnType<AiImageService['generate']>
  edit?(senderId: number, input: AiImageEditInput, progress?: AiOperationProgressObserver): ReturnType<AiImageService['edit']>
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
  generate(senderId: number, input: AiVideoGenerationInput, progress?: AiOperationProgressObserver): ReturnType<AiVideoService['generate']>
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

function sourceImageAssetIds(inputs: { image?: { assetId?: string }; images?: readonly { assetId?: string }[] }): string[] {
  return [...new Set(
    (inputs.images ?? (inputs.image ? [inputs.image] : []))
      .flatMap((asset) => asset.assetId ? [asset.assetId] : []),
  )]
}

function ownedInputAssetIds(
  assets: readonly { assetId?: string }[] | undefined,
  label: string,
): string[] {
  const entries = assets ?? []
  const ids = [...new Set(entries.flatMap((asset) => asset.assetId ? [asset.assetId] : []))]
  if (ids.length !== entries.length) throw new Error(`${label}需要连接已保存到本地资产库的素材`)
  return ids
}

function miniMaxMode(
  requested: CanvasNodeExecutionContextVideoMode,
  imageCount: number,
  videoCount: number,
  audioCount: number,
): MiniMaxVideoMode {
  if (requested && requested !== 'auto') return requested
  if (videoCount > 0 || audioCount > 0 || imageCount > 2) return 'ref2va'
  if (imageCount === 2) return 'fl2va'
  if (imageCount === 1) return 'i2va'
  return 't2va'
}

type CanvasNodeExecutionContextVideoMode = 'auto' | MiniMaxVideoMode | undefined

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

/**
 * What a paid request reports back to the run: its stages when the run shows
 * them, and the relay's request id for the run's 实扣. Undefined when the run
 * wants neither, so the request goes out exactly as it did before.
 */
function requestObserver(
  reportStage: CanvasNodeExecutionContext['reportStage'],
  billing: AiRelayBillingObserver | undefined,
  withProgress = false,
): AiOperationProgressObserver | undefined {
  if (!reportStage && !billing) return undefined
  return {
    onStage: reportStage ?? (() => undefined),
    ...(reportStage && withProgress ? { onProgress: (update: AiOperationProgressUpdate) => reportStage('processing', update) } : {}),
    ...(billing ? {
      onRelayDispatch: (sent: boolean) => billing.onRelayDispatch?.(sent),
      onRelayAnswer: (relayRequestId: string | null) => billing.onRelayAnswer?.(relayRequestId),
    } : {}),
  }
}

// addEventListener('abort') never fires for a signal that is already
// aborted, so a stop that lands before an executor starts would otherwise
// slip through and submit a paid generation request.
function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error('运行已取消')
}

/** What a canvas project can hold as a node's text result (canvas-project-package.ts). */
export const maximumCanvasTextOutputLength = 32_000

export function createCanvasNodeExecutors(options: {
  imageService: CanvasImageOperationService
  videoService?: CanvasVideoOperationService
  assets?: CanvasOwnedAssetService
  completeText?: CanvasTextCompletionService
  imageGroup?: string
  videoGroup?: string
  textGroup?: string
  /** Frame-extract nodes run only with it (画布完善第 7 条第二步); without it they stay refused. */
  frames?: CanvasFrameExtraction
  /** Image-tool nodes run only with it (第三步); without it they stay refused. */
  imageTools?: CanvasImageToolProcessing
}): CanvasNodeExecutors {
  const text: CanvasNodeExecutors['text'] = async ({ node }) => ({ outputText: node.data.prompt })
  const image: CanvasNodeExecutors['image'] = async ({ ownerId, userId, projectId, attemptId, node, inputs, signal, reportStage, billing }) => {
    const prompt = promptForNode(node.data.prompt, inputs.text)
    if (!prompt) throw new Error('请输入图像提示词或连接上游文本节点')
    const group = node.data.group || options.imageGroup || '图片模型'
    const requestId = `canvas-run:${attemptId}`
    throwIfCancelled(signal)
    const onAbort = () => { options.imageService.cancel(ownerId, requestId) }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      const input: AiImageGenerationInput = {
        requestId,
        group,
        model: node.data.model,
        prompt,
        expectedUserId: userId,
        ...(projectId ? { projectId } : {}),
        ...(node.data.size ? { size: node.data.size } : {}),
        ...(node.data.imageResolution ? { imageResolution: node.data.imageResolution } : {}),
        ...(node.data.quality === 'low'
          || node.data.quality === 'medium'
          || node.data.quality === 'high'
          || node.data.quality === 'auto'
          ? { quality: node.data.quality }
          : {}),
      }
      const observer = requestObserver(reportStage, billing)
      const assets = observer
        ? await options.imageService.generate(ownerId, input, observer)
        : await options.imageService.generate(ownerId, input)
      return imageResult(assets, group, node.data.model)
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }
  const imageEdit: CanvasNodeExecutors['image-edit'] = async ({ ownerId, userId, projectId, attemptId, node, inputs, signal, reportStage, billing }) => {
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
    const mask = node.data.imageEditMask
    // Checked again here, after the kernel's preflight, because the request
    // goes out whatever the canvas checked: a mask drawn on another image, or
    // on an image since swapped, fails before anything is paid.
    if (mask) assertCanvasImageEditMaskInput(mask, node.data.model, inputs.images ?? (inputs.image ? [inputs.image] : []))
    const group = node.data.group || options.imageGroup || '图片模型'
    const requestId = `canvas-run:${attemptId}`
    throwIfCancelled(signal)
    const onAbort = () => { options.imageService.cancel(ownerId, requestId) }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      const input: AiImageEditInput = {
        requestId,
        group,
        model: node.data.model,
        prompt,
        sourceAssetIds,
        ...(mask ? { mask: { width: mask.width, height: mask.height, png: (maskSignal: AbortSignal) => buildCanvasImageMaskPng(mask, maskSignal) } } : {}),
        expectedUserId: userId,
        ...(projectId ? { projectId } : {}),
        ...(node.data.size ? { size: node.data.size } : {}),
        ...(node.data.imageResolution ? { imageResolution: node.data.imageResolution } : {}),
        ...(node.data.quality === 'low'
          || node.data.quality === 'medium'
          || node.data.quality === 'high'
          || node.data.quality === 'auto'
          ? { quality: node.data.quality }
          : {}),
      }
      const observer = requestObserver(reportStage, billing)
      const assets = observer
        ? await options.imageService.edit(ownerId, input, observer)
        : await options.imageService.edit(ownerId, input)
      return imageResult(assets, group, node.data.model)
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }
  const imageOrEdit: CanvasNodeExecutors['image-generate'] = async (context) => {
    return sourceImageAssetIds(context.inputs).length > 0
      ? imageEdit(context)
      : image(context)
  }
  const passThrough: CanvasNodeExecutors['gallery'] = async ({ inputs }) => {
    const images = inputs.images ?? (inputs.image ? [inputs.image] : [])
    const videos = inputs.videos ?? (inputs.video ? [inputs.video] : [])
    const audios = inputs.audios ?? (inputs.audio ? [inputs.audio] : [])
    const assets = images.length > 0 ? images : videos.length > 0 ? videos : audios
    return {
      ...(inputs.text !== undefined ? { outputText: inputs.text } : {}),
      ...(assets.length > 0 ? { assets: assets.map((asset) => structuredClone(asset)) } : {}),
    }
  }
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
  const video: CanvasNodeExecutors['video'] = async ({ runId, graphRevision, ownerId, userId, projectId, attemptId, node, inputs, signal, reportStage, billing }) => {
    if (!options.videoService) throw new Error('视频生成能力尚未接入，当前不会提交付费请求')
    const prompt = promptForNode(node.data.prompt, inputs.text)
    if (!prompt) throw new Error('请输入视频提示词或连接上游文本节点')
    const group = node.data.group || options.videoGroup
    if (!group) throw new Error('视频节点缺少生成分组，已在付费请求前停止')
    const requestId = `canvas-run:${attemptId}`
    const capability = resolveAiModelCapability(node.data.model)
    if (capability.kind !== 'video') throw new Error('请选择可用的视频模型')
    const imageAssetIds = ownedInputAssetIds(inputs.images ?? (inputs.image ? [inputs.image] : []), '视频参考图片')
    const videoAssetIds = ownedInputAssetIds(inputs.videos ?? (inputs.video ? [inputs.video] : []), '视频参考视频')
    const audioAssetIds = ownedInputAssetIds(inputs.audios ?? (inputs.audio ? [inputs.audio] : []), '视频参考音频')
    throwIfCancelled(signal)
    const onAbort = () => { options.videoService?.cancel(ownerId, requestId) }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      const input: AiVideoGenerationInput = {
        requestId,
        group,
        model: node.data.model,
        prompt,
        seconds: node.data.seconds ?? '5',
        expectedUserId: userId,
        ...(projectId ? { projectId } : {}),
        runId,
        nodeId: node.id,
        attemptId,
        graphRevision,
        ...(capability.provider === 'minimax-h3' ? {
          mode: miniMaxMode(node.data.videoMode, imageAssetIds.length, videoAssetIds.length, audioAssetIds.length),
          resolution: node.data.videoResolution ?? '720p',
          aspectRatio: node.data.videoAspectRatio ?? '16:9',
          promptOptimization: node.data.promptOptimization ?? false,
          ...(imageAssetIds.length > 0 ? { imageAssetIds } : {}),
          ...(videoAssetIds.length > 0 ? { videoAssetIds } : {}),
          ...(audioAssetIds.length > 0 ? { audioAssetIds } : {}),
        } : {
          ...videoDimensions(node.data.size),
          ...(imageAssetIds[0] ? { imageAssetId: imageAssetIds[0] } : {}),
          ...(imageAssetIds.length > 1 ? { imageAssetIds } : {}),
          ...(videoAssetIds.length > 0 ? { videoAssetIds } : {}),
          ...(audioAssetIds.length > 0 ? { audioAssetIds } : {}),
        }),
      }
      const observer = requestObserver(reportStage, billing, true)
      const asset = observer
        ? await options.videoService.generate(ownerId, input, observer)
        : await options.videoService.generate(ownerId, input)
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
  // 画布完善第 7 条第二步：主进程不解视频，只核对视频是这个账号的、页面解得动，再请页面抽出那一帧交回来。
  // 不发任何付费请求；等的这段时间节点显示「处理中」，画布顶上写「正在准备视频帧图片」。
  const frameExtract: CanvasNodeExecutors['image-edit'] = async ({ runId, attemptId, userId, projectId, node, inputs, signal, reportFramePreparation }) => {
    const frames = options.frames
    if (!frames || !reportFramePreparation) throw new Error('「视频抽帧」节点桌面版暂不支持，本次没有提交任何付费请求')
    const video = inputs.video
    if (!video) throw new Error('请先给视频抽帧节点连接一段视频')
    await frames.assertDecodableVideo(userId, video.assetId)
    throwIfCancelled(signal)
    // The web host names the operation after the attempt too; the kernel checks they match.
    const preparation = {
      operationId: attemptId,
      nodeId: node.id,
      attemptId,
      sourceAssetId: video.assetId,
      timestampSeconds: node.data.frameTimestampSeconds ?? 0,
    }
    const frame = frames.waitForFrame({ runId, userId, ...(projectId ? { projectId } : {}), preparation, signal })
    void frame.catch(() => undefined)
    try {
      await reportFramePreparation(preparation, true)
      return { assets: [await frame] }
    } finally {
      await reportFramePreparation(preparation, false)
    }
  }
  // 画布完善第 7 条第三步：裁剪、拼图、宫格裁剪、平铺、图层合成。主进程不处理像素，只核对来源是这个账号、这个项目的
  // 图片、张数和大小在网页版的上限内，再请页面按节点上的参数做好交回来。不发任何付费请求。
  const imageTransform: CanvasNodeExecutors['image-crop'] = async ({ runId, attemptId, userId, projectId, node, inputs, signal, reportImagePreparation }) => {
    const label = canvasRunImageToolNodeLabels[node.kind as keyof typeof canvasRunImageToolNodeLabels] ?? '图片处理'
    const tools = options.imageTools
    const kind = canvasImageTransformKindForNode(node.kind)
    if (!tools || !reportImagePreparation || !kind) throw new Error(`「${label}」节点桌面版暂不支持，本次没有提交任何付费请求`)
    if (!projectId) throw new Error('画布项目尚未选择，无法保存图片处理结果')
    if (!node.data.imageTransform) throw new Error('请先设置图像工具参数')
    // Parsed when the run started; read again here only for what the pictures are checked against.
    const { expectation, layerGroups } = parseCanvasImageTransformRecipe(node.kind, node.data.imageTransform, { remaining: Number.MAX_SAFE_INTEGER })
    const connected = inputs.imageSources ?? []
    let sources = connected
    if (kind === 'collage') sources = orderCanvasCollageSources(connected, node.data.imageCollageInputOrder)
    if (kind === 'tile') {
      const chosen = selectCanvasTileSource(connected, node.data.tileInput)
      sources = chosen ? [chosen] : []
    }
    // The kernel checks the rest (collage capacity, layer references) before the run starts.
    if (kind === 'crop' && sources.length !== 1) throw new Error('裁剪只能使用一个图片来源')
    if (kind === 'grid-split' && sources.length !== 1) throw new Error('宫格裁剪只能使用一个图片来源')
    if (kind === 'tile' && sources.length !== 1) throw new Error('平铺图片每次只能使用一张输入图片')
    if (kind === 'collage' && sources.length < 1) throw new Error('请连接可读取的图片来源')
    if (sources.length > maximumCanvasImageTransformInputs) throw new Error('图片处理最多用 20 张图片')
    const sourceAssetIds = sources.map((source) => source.asset.assetId)
    await tools.assertSources(userId, projectId, sourceAssetIds)
    throwIfCancelled(signal)
    // The web host names the operation after the attempt too; the kernel checks they match.
    const preparation: CanvasImagePreparation = {
      operationId: attemptId,
      attemptId,
      runId,
      projectId,
      nodeId: node.id,
      sourceAssetIds,
      recipe: structuredClone(node.data.imageTransform),
      ...(layerGroups ? { layerGroupsVersion: 1 as const } : {}),
      processorRevision: canvasImageTransformProcessorRevision,
    }
    const pictures = tools.waitForImages({ runId, userId, projectId, preparation, expectation, signal })
    void pictures.catch(() => undefined)
    try {
      await reportImagePreparation(preparation, true)
      return { assets: await pictures }
    } finally {
      await reportImagePreparation(preparation, false)
    }
  }
  // 图片对比、全景预览不处理图片，跟网页版一样把连进来的图原样往下传。
  const imagePassThrough: CanvasNodeExecutors['image-compare'] = async ({ inputs }) => {
    const images: CanvasRunAsset[] = inputs.images ?? (inputs.image ? [inputs.image] : [])
    if (images.length === 0) throw new Error('请连接可读取的图片来源')
    return { assets: images.map((asset) => structuredClone(asset)) }
  }
  const dramaParse: CanvasNodeExecutors['drama-parse'] = async ({ node, inputs, signal, billing }) => {
    const script = [inputs.text, node.data.prompt].filter((part) => part && part.trim()).join('\n').trim()
    if (!script) throw new Error('请先连接或粘贴剧本文本')
    if (!options.completeText) throw new Error('剧本解析服务未就绪')
    const group = node.data.group || options.textGroup || ''
    if (!group) throw new Error('请先在「生成配置」中选择文字分组')
    const model = node.data.model.trim()
    if (!model) throw new Error('请选择文字模型')
    function failure(error: unknown): Error {
      const detail = error instanceof Error ? error.message : String(error)
      return new Error(detail.includes('剧本') ? detail : `剧本解析失败：${detail.slice(0, 300)}`)
    }
    async function requestOnce(): Promise<string> {
      try {
        return await options.completeText!.completeOnce({
          group,
          model,
          system: dramaParseSystemPrompt,
          user: script,
          signal,
          ...(billing ? { billing } : {}),
        })
      } catch (error) {
        if (signal.aborted) throw error
        throw failure(error)
      }
    }
    // 只有模型答了、但答出来的表格读不懂时才再问一次。请求本身失败（断网、超时、
    // 余额不足）再发一次只会多扣一次钱，结果还是一样。
    const raw = await requestOnce()
    try {
      return { outputText: JSON.stringify(parseDramaTablesJson(raw).tables), group, model }
    } catch (error) {
      if (signal.aborted) throw error
    }
    const retried = await requestOnce()
    try {
      return { outputText: JSON.stringify(parseDramaTablesJson(retried).tables), group, model }
    } catch (error) {
      throw failure(error)
    }
  }
  // 画布完善第 6 条：文字生成节点。跟网页版服务端同一个做法（xingmang-canvas
  // lib/canvas-runs.ts）：上游文字和节点自己的提示词按行拼起来，原样作为一条用户消息
  // 发出，不加系统提示；连了图片就一起给模型看。结果超过 32000 字不收，跟画布能存的
  // 文字结果一样长。
  const textGenerate: CanvasNodeExecutors['text-generate'] = async ({ projectId, node, inputs, signal, billing }) => {
    const prompt = [inputs.text, node.data.prompt].filter((part) => part && part.trim()).join('\n')
    if (!prompt.trim()) throw new Error('请输入文字提示词或连接上游提示词节点')
    if (!options.completeText) throw new Error('文字生成服务未就绪')
    const group = node.data.group || options.textGroup || ''
    if (!group) throw new Error('请先在「生成配置」中选择文字分组')
    const model = node.data.model.trim()
    if (!model) throw new Error('请选择文字模型')
    const images = inputs.images ?? (inputs.image ? [inputs.image] : [])
    assertCanvasTextImageInput(model, images.length)
    const outputText = await options.completeText.completeOnce({
      group,
      model,
      user: prompt,
      ...(images.length ? { images: { assetIds: images.map((asset) => asset.assetId), ...(projectId ? { projectId } : {}) } } : {}),
      signal,
      ...(billing ? { billing } : {}),
    })
    if (outputText.length > maximumCanvasTextOutputLength) throw new Error('文字结果超过 32000 字上限，请调整生成长度后再运行')
    return { outputText, group, model }
  }
  const dramaText: CanvasNodeExecutors['drama-bible'] = async ({ node, inputs }) => ({
    outputText: [inputs.text, node.data.prompt].filter((part) => part && part.trim()).join('\n').trim(),
  })
  const dramaAsset: CanvasNodeExecutors['drama-character'] = async ({ userId, node, inputs }) => {
    const images = inputs.images ?? (inputs.image ? [inputs.image] : [])
    if (images.length > 0) return { assets: images.map((asset) => structuredClone(asset)), outputText: node.data.prompt }
    const assetId = node.data.adoptedAssetId
    if (assetId && options.assets) {
      const owned = await options.assets.readOwned(userId, assetId)
      return { assets: [{ kind: 'image', ...owned.asset }], outputText: node.data.prompt }
    }
    return { outputText: node.data.prompt }
  }
  return {
    text, prompt: text, image: imageOrEdit, 'image-generate': imageOrEdit,
    video, 'video-generate': video, 'image-edit': imageEdit,
    'frame-extract': options.frames ? frameExtract : unsupported, 'video-input': videoInput,
    'image-input': imageInput, 'audio-input': audioInput, router: passThrough, gallery: passThrough, output: passThrough,
    group: passThrough, note: text,
    'drama-bible': dramaText, 'drama-script': dramaText, 'drama-parse': dramaParse, 'drama-shot': dramaText,
    'drama-character': dramaAsset, 'drama-scene': dramaAsset, 'drama-prop': dramaAsset,
    'text-generate': textGenerate,
    ...(options.imageTools ? {
      'image-crop': imageTransform,
      'image-collage': imageTransform,
      'image-grid-split': imageTransform,
      'image-tile': imageTransform,
      'image-layer': imageTransform,
      'image-compare': imagePassThrough,
      'image-panorama': imagePassThrough,
    } : {}),
  }
}

// 主窗口业务通道的处理器：视频剪辑页出视频片段、写分镜、存成片。
// 片段和成片都放进全局作品库，和对话里出的图片同一处。界面只拿编号、缩略图、宽高和时长；
// 文件路径不出主进程，打开、另存都由这边按编号找文件。
import type { WebContents } from 'electron'
import { assetThumbnailUrl } from '../../asset-thumbnail'
import { BoundedOperationQueue } from '../../bounded-operation-queue'
import { CanvasGenerationAdmission } from '../../canvas-generation-admission'
import type { AiOperationProgressObserver, AiOperationProgressStage } from '../../ai-operation-progress'
import type { AiStoredVideoAsset } from '../../ai-video-asset-store'
import { ipcEventChannels, type AiVideoClip, type AiVideoProgressEvent } from '../../ipc-contract'
import { videoStudioOffMessage } from '../../remote-features'
import { buildVideoStudioPlanMessages, parseVideoStudioPlanJson } from '../../video-studio-plan'
import { requiredString } from '../parsers/common'
import {
  parseAiVideoAssetId,
  parseAiVideoGenerateInput,
  parseVideoStudioExportBytes,
  parseVideoStudioPlanInput,
} from '../parsers/ai-video'
import type { IpcHandlerContext } from './context'

// 分镜要有点变化：同一句想法再写一次，或者第一次没按格式答、再问一次时，回答不该一模一样。
const planTemperature = 0.7
// 读片段、存成片一次搬一整段视频（最多 512 MB）。页面本来就一段一段读、拼完才存一次，主进程这边再按窗口排成
// 一队、一次只搬一段：页面出错或被投毒时连发，也撑不爆主进程内存。排队的再多就直接拒，正常用碰不到。
const maximumQueuedClipTransfers = 12

export function toAiVideoClip(asset: Pick<AiStoredVideoAsset, 'assetId' | 'width' | 'height' | 'durationSeconds'>): AiVideoClip {
  return {
    assetId: asset.assetId,
    thumbnailUrl: assetThumbnailUrl(asset.assetId, 'video'),
    ...(asset.width ? { width: asset.width } : {}),
    ...(asset.height ? { height: asset.height } : {}),
    ...(asset.durationSeconds ? { durationSeconds: asset.durationSeconds } : {}),
  }
}

function sendProgress(sender: WebContents, event: AiVideoProgressEvent): void {
  if (!sender.isDestroyed()) sender.send(ipcEventChannels.onAiVideoProgress, event)
}

export function createAiVideoProgressForwarder(sender: WebContents, requestId: string): AiOperationProgressObserver {
  let stage: AiOperationProgressStage = 'processing'
  return {
    onStage(next) {
      stage = next
      sendProgress(sender, { requestId, stage })
    },
    onProgress(update) {
      sendProgress(sender, {
        requestId,
        stage,
        ...(update.value === undefined ? {} : { value: Math.round(update.value) }),
        ...(update.health === 'delayed' ? { delayed: true } : {}),
      })
    },
  }
}

export function registerAiVideoHandlers(ctx: IpcHandlerContext): void {
  const { options, registerTrustedHandler, accountService, externalShell } = ctx
  // 正在写的分镜，按「窗口:请求」记；停下、关窗都从这里找。
  const plans = new Map<string, AbortController>()
  // 页面自己最多同时出三段（useVideoStudio.ts）；主进程照画布那套（canvas-window.ts）按窗口再兜一层，
  // 页面出错或被投毒时不能借这条通道连发付费视频。正常用碰不到这两个上限。
  const generation = new CanvasGenerationAdmission()
  const transfers = new Map<number, BoundedOperationQueue>()
  const observedSenders = new WeakSet<WebContents>()
  const observeSender = (sender: WebContents): void => {
    if (observedSenders.has(sender)) return
    observedSenders.add(sender)
    sender.once('destroyed', () => {
      options.videoService?.cancelSender(sender.id)
      for (const [key, controller] of plans) {
        if (key.startsWith(`${sender.id}:`)) controller.abort()
      }
      generation.releaseOwner(sender.id)
      transfers.get(sender.id)?.shutdown()
      transfers.delete(sender.id)
    })
  }
  const transferClip = <T>(sender: WebContents, operation: () => Promise<T>): Promise<T> => {
    observeSender(sender)
    let queue = transfers.get(sender.id)
    if (!queue) {
      queue = new BoundedOperationQueue({ maxActive: 1, maxQueued: maximumQueuedClipTransfers })
      transfers.set(sender.id, queue)
    }
    return queue.enqueue(operation).promise
  }
  const currentUserId = (): number => {
    const session = accountService.getSessionState()
    const userId = session.authenticated ? session.account?.userId : undefined
    if (!userId) throw new Error('请先登录星芒账号')
    return userId
  }
  const videoAssets = () => {
    if (!options.videoAssets) throw new Error('视频作品库未就绪')
    return options.videoAssets
  }

  registerTrustedHandler('video-studio:plan', async (event, input: unknown) => {
    const chatService = options.chatService
    if (!chatService) throw new Error('AI聊天服务未就绪')
    const parsed = parseVideoStudioPlanInput(input)
    currentUserId()
    await options.remoteFeatures?.assertOn('video-studio', videoStudioOffMessage)
    observeSender(event.sender)
    const key = `${event.sender.id}:${parsed.requestId}`
    if (plans.has(key)) throw new Error('这份分镜正在写，请等它写完')
    const controller = new AbortController()
    plans.set(key, controller)
    const { system, user } = buildVideoStudioPlanMessages(parsed)
    const ask = () => chatService.completeOnce({
      group: parsed.group,
      model: parsed.model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      parameters: { temperature: planTemperature },
      signal: controller.signal,
    })
    try {
      // 只有模型答了、但答出来读不懂时才再问一次（同画布的剧本解析）。请求本身失败
      // （断网、超时、余额不足）再发一次只会多扣一次钱，结果还是一样。
      const first = await ask()
      try {
        return parseVideoStudioPlanJson(first, parsed)
      } catch (error) {
        if (controller.signal.aborted) throw error
      }
      return parseVideoStudioPlanJson(await ask(), parsed)
    } catch (error) {
      if (controller.signal.aborted) throw new Error('已停止写分镜')
      throw error
    } finally {
      if (plans.get(key) === controller) plans.delete(key)
    }
  })

  registerTrustedHandler('video:generate', async (event, input: unknown) => {
    const videoService = options.videoService
    if (!videoService) throw new Error('视频服务未就绪')
    const parsed = parseAiVideoGenerateInput(input)
    const expectedUserId = currentUserId()
    // 只拦新交出去的；接回上次没等到的（video:resume）照旧，那一段已经扣过钱。
    await options.remoteFeatures?.assertOn('video-studio', videoStudioOffMessage)
    observeSender(event.sender)
    const asset = await generation.run(event.sender.id, () => videoService.generate(
      event.sender.id,
      { ...parsed, expectedUserId },
      createAiVideoProgressForwarder(event.sender, parsed.requestId),
    ))
    return toAiVideoClip(asset)
  })

  // 视频剪辑页重开时接回上次没等到的片段（关了软件、刷新了页面）。只按请求号查这个账号自己的任务记录，
  // 不收模型、分组这些：找到的那一单怎么查、扣的哪份钱，都按当初提交时记下的来。
  registerTrustedHandler('video:resume', async (event, requestId: unknown) => {
    const videoService = options.videoService
    if (!videoService) throw new Error('视频服务未就绪')
    const id = requiredString(requestId, '视频请求标识', 160)
    const userId = currentUserId()
    observeSender(event.sender)
    const asset = await videoService.resumeRequest(event.sender.id, userId, id, createAiVideoProgressForwarder(event.sender, id))
    return asset ? toAiVideoClip(asset) : null
  })

  registerTrustedHandler('video:cancel', (event, requestId: unknown) => {
    const id = requiredString(requestId, '视频请求标识', 160)
    const plan = plans.get(`${event.sender.id}:${id}`)
    if (plan && !plan.signal.aborted) {
      plan.abort()
      return { canceled: true, mayStillComplete: false }
    }
    const session = accountService.getSessionState()
    const userId = session.authenticated ? session.account?.userId : undefined
    return options.videoService?.cancel(event.sender.id, id, userId) ?? { canceled: false, mayStillComplete: false }
  })

  registerTrustedHandler('video:read-clip', async (event, assetId: unknown) => {
    const id = parseAiVideoAssetId(assetId)
    const store = videoAssets()
    currentUserId()
    // 排到了再认一次账号：排队时换了号，不能把前一个号的片段读给新号的页面。
    return transferClip(event.sender, async () => (await store.readOwned(currentUserId(), id)).bytes)
  })

  registerTrustedHandler('video-studio:store-export', async (event, bytes: unknown) => {
    const parsed = parseVideoStudioExportBytes(bytes)
    const store = videoAssets()
    // 存进拼它的那个账号：排队时换了号，也不能存进新号的作品库。
    const userId = currentUserId()
    return transferClip(event.sender, async () => toAiVideoClip(await store.storeComposed(userId, parsed)))
  })

  // 交给系统按 .mp4 的默认程序打开（Windows 上经资源管理器转交，不从本进程直接起，system-shell.ts）。
  // 路径由作品库按编号找到，只会是这个账号自己作品目录里的 xingmang-<编号>.mp4。
  registerTrustedHandler('video:open', async (_event, assetId: unknown) => {
    const filePath = await videoAssets().resolveOwnedFilePath(currentUserId(), parseAiVideoAssetId(assetId))
    await externalShell.openPath(filePath)
  })

  registerTrustedHandler('video:save-as', async (_event, assetId: unknown) => {
    const userId = currentUserId()
    const saved = await videoAssets().saveAs(userId, parseAiVideoAssetId(assetId), () => {
      if (currentUserId() !== userId) throw new Error('账号已切换，请重新另存')
    })
    return { saved }
  })
}

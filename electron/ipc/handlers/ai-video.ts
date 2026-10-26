// 主窗口业务通道的处理器：出视频片段（对话页和视频剪辑页共用），视频剪辑页的分镜和成片。
// 片段和成片都放进全局作品库，和对话里出的图片同一处。界面只拿编号、缩略图、宽高和时长；
// 文件路径不出主进程，打开、另存都由这边按编号找文件。
import type { WebContents } from 'electron'
import { assetThumbnailUrl } from '../../asset-thumbnail'
import type { AiOperationProgressObserver, AiOperationProgressStage } from '../../ai-operation-progress'
import type { AiStoredVideoAsset } from '../../ai-video-asset-store'
import { ipcEventChannels, type AiVideoClip, type AiVideoProgressEvent } from '../../ipc-contract'
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
  const observedSenders = new WeakSet<WebContents>()
  const observeSender = (sender: WebContents): void => {
    if (observedSenders.has(sender)) return
    observedSenders.add(sender)
    sender.once('destroyed', () => {
      options.videoService?.cancelSender(sender.id)
      for (const [key, controller] of plans) {
        if (key.startsWith(`${sender.id}:`)) controller.abort()
      }
    })
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
    observeSender(event.sender)
    const asset = await videoService.generate(
      event.sender.id,
      { ...parsed, expectedUserId },
      createAiVideoProgressForwarder(event.sender, parsed.requestId),
    )
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

  registerTrustedHandler('video:read-clip', async (_event, assetId: unknown) => {
    const owned = await videoAssets().readOwned(currentUserId(), parseAiVideoAssetId(assetId))
    return owned.bytes
  })

  registerTrustedHandler('video-studio:store-export', async (_event, bytes: unknown) => {
    const parsed = parseVideoStudioExportBytes(bytes)
    return toAiVideoClip(await videoAssets().storeComposed(currentUserId(), parsed))
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

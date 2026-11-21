import { aiVideoUnconfirmedSubmissionMessage, isAiVideoUnconfirmedSubmission } from '../../../../electron/ai-video-submission'
import type { AiVideoClip, AiVideoGenerateInput, AiVideoProgressEvent } from '../../../../electron/ipc-contract'
import { buildVideoClipRequest, clampVideoStudioSeconds, videoStudioSecondsChoices, type VideoStudioClipSource } from '../video-studio/project'
import { chatVideoAspect, chatVideoSeconds, type ChatMessage, type ChatSettings, type ChatVideoAspect, type ChatWorkspace, type Conversation } from './state'

// 「生成视频」那一档（融合第 2 步）的纯计算：交给主进程的请求、一条视频回复收尾成什么样、页面上那几行字。
// 请求在 useChatController 里发。扣费上的规矩照视频工作台（video-studio/useVideoStudio.ts）：请求号先存再交；
// 交出去的那一单停不下来就接着等；提交结果不明的再出一次要先说清可能多扣。

/** 同时在出的视频最多这么多段，同视频工作台：一段要几分钟，全部一起发容易被服务端限流。 */
export const maxParallelChatVideos = 3
export const chatVideoFailedMessage = '此片段生成失败，请稍后重新生成'
export const chatVideoBusyMessage = `已有 ${maxParallelChatVideos} 段视频正在生成，请等待其中一段完成后再发送`
/** 点了「停止」，可这一单已经交给服务端：说清钱已经扣了、这里接着等。 */
export const chatVideoBilledNotice = '该片段已提交至服务端并完成扣费，无法中止；将继续等待生成完成，完成后保留在此处。'

/** 这一单出到哪一步；只在这一次打开页面时有，不存。 */
export interface ChatVideoProgress { stage: AiVideoProgressEvent['stage']; value?: number; delayed?: boolean }

/** 这个视频模型能选的几档时长里，离记着的那一档最近的；模型还没定时照记着的。 */
export function chatVideoSecondsFor(settings: Pick<ChatSettings, 'model' | 'videoSeconds'>): number {
  const seconds = chatVideoSeconds(settings)
  return settings.model ? clampVideoStudioSeconds(seconds, settings.model) : seconds
}

/** 时长菜单里列的几档。 */
export function chatVideoSecondsChoices(model: string): number[] {
  return videoStudioSecondsChoices(model)
}

/** 交给主进程的那一单。带了图就从这张图开始出（只收一张，planTurn 已经拦过多的）。 */
export function buildChatVideoRequest(settings: ChatSettings, prompt: string, imageAssetId: string | undefined, requestId: string): AiVideoGenerateInput {
  return buildVideoClipRequest({ requestId, group: settings.group, model: settings.model, prompt, seconds: chatVideoSecondsFor(settings), aspect: chatVideoAspect(settings), ...(imageAssetId ? { imageAssetId } : {}) })
}

/** 片段回来了。 */
export function completeChatVideo(message: ChatMessage, clip: AiVideoClip): ChatMessage {
  if (message.status !== 'pending' && message.status !== 'streaming') return message
  const { requestId: _requestId, error: _error, mayStillComplete: _mayStillComplete, ...rest } = message
  return { ...rest, status: 'complete', video: { clip } }
}

/**
 * 这一单没出成、或者停下了，这条回复收尾成什么样（同视频工作台的 settleShot）。
 * 给了 error 就是「没成功」，请求号留着：「暂时查不到进度」这类失败时服务端多半还在出，下次打开拿它接回来；
 * missing（主进程说没有这一单）时不留，重新生成就是新的一单。
 * 提交结果不明的另记 unconfirmed（钱可能扣了、却接不回来，重新生成前要说清可能多扣一次）：主进程那句
 * 「提交结果不明确」；上一次就不明、这一次沿用请求号又没出成；主进程当初没记下这一单（unrecorded）、现在又查不到。
 * 没给 error 是还没交出去就停住了：没花钱，照「已停止」。
 */
export function settleChatVideo(message: ChatMessage, error?: string, missing = false): ChatMessage {
  if (message.status !== 'pending' && message.status !== 'streaming') return message
  const { requestId: _requestId, error: _error, mayStillComplete: _mayStillComplete, ...rest } = message
  const requestId = message.video?.requestId
  const unconfirmed = Boolean(requestId) && (message.video?.unconfirmed === true || (missing && message.video?.unrecorded === true) || (error !== undefined && isAiVideoUnconfirmedSubmission(error)))
  const text = unconfirmed && (!error || missing) ? aiVideoUnconfirmedSubmissionMessage : error
  if (!text) return { ...rest, status: 'canceled', video: {} }
  return { ...rest, status: 'error', error: text, video: unconfirmed && requestId ? { requestId, unconfirmed: true } : requestId && !missing ? { requestId } : {} }
}

export interface PendingChatVideo { conversationId: string; messageId: string; requestId: string }

/** 还在等的那几段视频：页面打开时逐个拿请求号回主进程接。 */
export function pendingChatVideos(state: ChatWorkspace): PendingChatVideo[] {
  return state.conversations.flatMap((conversation) => conversation.messages.flatMap((message) => {
    const requestId = message.requestId
    return message.video && requestId && (message.status === 'pending' || message.status === 'streaming') ? [{ conversationId: conversation.id, messageId: message.id, requestId }] : []
  }))
}

/**
 * 「重新生成」一条视频回复时拿上一单怎么办：
 * reuse：上一次提交结果不明，沿用原来的请求号重新交（MiniMax 拿它去重，服务端其实收下过就不会再出一份）；
 * resume：上一单没等到结果就失败了，先拿请求号接回，接得回来不用再付一次钱，主进程确实没有这一单才重新交；
 * fresh：新的一单。
 */
export type ChatVideoRetry = { kind: 'fresh' } | { kind: 'reuse'; requestId: string } | { kind: 'resume'; requestId: string }
export function chatVideoRetry(message: ChatMessage | undefined): ChatVideoRetry {
  const requestId = message?.video?.requestId
  if (!requestId || message?.video?.clip) return { kind: 'fresh' }
  return message?.video?.unconfirmed ? { kind: 'reuse', requestId } : { kind: 'resume', requestId }
}

/** 等着的那一块上写的字：「正在生成视频 42%」，下载、保存时照视频工作台的说法。 */
export function chatVideoProgressText(progress: ChatVideoProgress | undefined): string {
  if (progress?.delayed) return '排队较久'
  if (progress?.stage === 'downloading') return `正在下载${progress.value === undefined ? '' : ` ${progress.value}%`}`
  if (progress?.stage === 'saving') return '正在保存'
  return `正在生成视频${progress?.value === undefined ? '' : ` ${progress.value}%`}`
}

/** 片段下面那行小字：「1280 × 720 · 5 秒」。主进程没量出来的那一项不写。 */
export function chatVideoDetail(clip: AiVideoClip): string {
  const seconds = clip.durationSeconds ? Math.round(clip.durationSeconds) : 0
  return [clip.width && clip.height ? `${clip.width} × ${clip.height}` : '', seconds > 0 ? `${seconds} 秒` : ''].filter(Boolean).join(' · ')
}

/** 缩略图角上的时长：「0:05」。 */
export function chatVideoDuration(clip: AiVideoClip): string {
  const seconds = clip.durationSeconds ? Math.round(clip.durationSeconds) : 0
  return seconds > 0 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : ''
}

/** 这一段视频是照什么出的：「添加到视频 › 新建视频」时，新的那一条画面比例、出片的模型跟着它走。 */
export interface ChatVideoMade { aspect: ChatVideoAspect; model: string; group: string; seconds: number }

/**
 * 画面比例、时长先看片段自己量出来的（主进程读的文件），量不出来才照当时的设置。模型只认「生成视频」那一档记下的：
 * 这条回复没记设置、对话后来又换成别的档时不拿聊天、画图的模型去充数，留空让视频工作台自己挑默认的。
 */
export function chatVideoMade(settings: ChatSettings, clip: AiVideoClip): ChatVideoMade {
  const video = settings.mode === 'video'
  const aspect = clip.width && clip.height ? (clip.width > clip.height ? '16:9' : clip.width < clip.height ? '9:16' : '1:1') : chatVideoAspect(settings)
  const seconds = clip.durationSeconds ? Math.round(clip.durationSeconds) : 0
  return { aspect, model: video ? settings.model : '', group: video ? settings.group : '', seconds: seconds > 0 ? seconds : chatVideoSecondsFor(settings) }
}

/** 这条视频回复是照哪句话、哪张图出的：它前面最近的那条用户消息。「添加到视频」「另存视频」要用。 */
export function chatVideoSource(conversation: Pick<Conversation, 'messages'>, messageId: string): VideoStudioClipSource | null {
  const index = conversation.messages.findIndex((message) => message.id === messageId)
  const clip = index < 0 ? undefined : conversation.messages[index].video?.clip
  if (!clip) return null
  const asked = conversation.messages.slice(0, index).reverse().find((message) => message.role === 'user')
  const imageAssetId = asked?.assets?.[0]?.assetId
  return { prompt: asked?.content ?? '', clip, ...(imageAssetId ? { imageAssetId } : {}) }
}

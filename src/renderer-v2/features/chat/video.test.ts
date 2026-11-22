import { describe, expect, it } from 'vitest'
import { aiVideoUnconfirmedSubmissionMessage } from '../../../../electron/ai-video-submission'
import { assetThumbnailUrl } from '../../../../electron/asset-thumbnail'
import type { AiChatAsset, AiVideoClip } from '../../../../electron/ipc-contract'
import { canStartVideoFromImage } from './api'
import {
  buildChatCatalog, CHAT_VIDEO_PROMPT_LIMIT, chatErrorMessage, chatVideoAspect, chatVideoSeconds, createConversation, createWorkspace, DEFAULT_VIDEO_MODELS, isGenerating, isGeneratingImage,
  isGeneratingReply, isGeneratingVideo, modeFilesMessage, noVideoStartImageMessage, planTurn, resolveDefaultChatModel, shouldShowOfflineReplyNotice, videoModeFilesMessage, videoPromptLengthError,
  videoStartImageLimitMessage, type ChatMessage, type ChatSettings, type Conversation,
} from './state'
import {
  buildChatVideoRequest, chatVideoBilledNotice, chatVideoBusyMessage, chatVideoDetail, chatVideoDuration, chatVideoFailedMessage, chatVideoMade, chatVideoProgressText, chatVideoRetry,
  chatVideoSecondsChoices, chatVideoSecondsFor, chatVideoSource, completeChatVideo, maxParallelChatVideos, pendingChatVideos, settleChatVideo,
} from './video'

const assetId = 'v'.repeat(43)
const clip: AiVideoClip = { assetId, thumbnailUrl: assetThumbnailUrl(assetId, 'video'), width: 1280, height: 720, durationSeconds: 5 }
const image: AiChatAsset = { assetId: 'i'.repeat(43), localUrl: `xingmang-asset://image/${'i'.repeat(43)}`, mimeType: 'image/png', fileName: 'start.png' }

function videoConversation(patch: Partial<ChatSettings> = {}): Conversation {
  const conversation = createConversation(undefined, 'conversation-video')
  conversation.settings = { ...conversation.settings, mode: 'video', group: '图片模型', model: 'grok-imagine-video-1.5', ...patch }
  return conversation
}
function ask(conversation = videoConversation(), extra: Partial<Parameters<typeof planTurn>[1]> = {}) {
  return planTurn(conversation, { prompt: '一只橘猫在雨里慢慢走', requestId: 'request-video-1', assistantId: 'assistant-video', userMessageId: 'user-video', ...extra })
}
function reply(conversation: Conversation): ChatMessage { return conversation.messages.find((message) => message.role === 'assistant')! }

describe('v2 chat video turns', () => {
  it('plans one clip per message and stores the request id inside the reply before anything is sent', () => {
    const plan = ask()
    expect(plan.settings.mode).toBe('video')
    const waiting = reply(plan.conversation)
    expect(waiting.status).toBe('pending')
    expect(waiting.requestId).toBe('request-video-1')
    expect(waiting.video).toEqual({ requestId: 'request-video-1' })
    expect(plan.conversation.messages[0]).toMatchObject({ role: 'user', content: '一只橘猫在雨里慢慢走' })
  })

  it('carries the unconfirmed warning along when the previous request id is reused', () => {
    expect(reply(ask(videoConversation(), { videoUnconfirmed: true }).conversation).video).toEqual({ requestId: 'request-video-1', unconfirmed: true })
  })

  it('takes one start image and passes it to the plan', () => {
    const plan = ask(videoConversation(), { images: [image] })
    expect(plan.images).toEqual([image])
    expect(plan.conversation.messages[0].assets).toEqual([image])
  })

  it('refuses an empty prompt, text files, a second image and an overlong prompt with a line the page can show', () => {
    expect(() => ask(videoConversation(), { prompt: '   ' })).toThrow('请先输入消息内容')
    expect(() => ask(videoConversation(), { files: [{ name: 'a.txt', size: 1, text: 'x', truncated: false }] })).toThrow(videoModeFilesMessage)
    expect(() => ask(videoConversation(), { images: [image, { ...image, assetId: 'j'.repeat(43) }] })).toThrow(videoStartImageLimitMessage)
    expect(() => ask(videoConversation(), { prompt: 'x'.repeat(CHAT_VIDEO_PROMPT_LIMIT + 1) })).toThrow(`单条视频描述最多 ${CHAT_VIDEO_PROMPT_LIMIT} 个字符`)
    expect(() => ask(videoConversation(), { prompt: 'x'.repeat(CHAT_VIDEO_PROMPT_LIMIT) })).not.toThrow()
    for (const message of [videoModeFilesMessage, videoStartImageLimitMessage, noVideoStartImageMessage, `单条视频描述最多 ${CHAT_VIDEO_PROMPT_LIMIT} 个字符`]) expect(chatErrorMessage(new Error(message))).toBe(message)
    expect(modeFilesMessage('video')).toBe(videoModeFilesMessage)
    expect(modeFilesMessage('image')).not.toBe(videoModeFilesMessage)
  })

  it('refuses a start image when the model is not a video model that can begin from one', () => {
    expect(canStartVideoFromImage('grok-imagine-video-1.5')).toBe(true)
    expect(canStartVideoFromImage('minimax-h3-base')).toBe(true)
    expect(canStartVideoFromImage('gpt-image-2')).toBe(false)
    expect(canStartVideoFromImage('')).toBe(false)
    expect(() => ask(videoConversation({ model: 'gpt-image-2' }), { images: [image] })).toThrow(noVideoStartImageMessage)
  })

  it('says how long the prompt is only once it is over the limit', () => {
    expect(videoPromptLengthError('x'.repeat(CHAT_VIDEO_PROMPT_LIMIT))).toBe('')
    expect(videoPromptLengthError(`  ${'x'.repeat(CHAT_VIDEO_PROMPT_LIMIT + 3)}  `)).toBe(`视频描述最多 ${CHAT_VIDEO_PROMPT_LIMIT} 字，当前 ${CHAT_VIDEO_PROMPT_LIMIT + 3} 字，请删减后再发送。`)
  })

  it('defaults to a landscape five-second clip and picks the preferred video model the account has', () => {
    expect(chatVideoAspect({})).toBe('16:9')
    expect(chatVideoSeconds({})).toBe(5)
    expect(chatVideoAspect({ videoAspect: '9:16' })).toBe('9:16')
    expect(chatVideoSeconds({ videoSeconds: 8 })).toBe(8)
    expect(resolveDefaultChatModel('video', ['minimax-h3-base', 'grok-imagine-video-1.5', 'gpt-image-2'])).toBe('grok-imagine-video-1.5')
    expect(resolveDefaultChatModel('video', ['minimax-h3-fast', 'minimax-h3-base'])).toBe('minimax-h3-base')
    expect(resolveDefaultChatModel('video', ['minimax-h3-fast', 'minimax-h3-base'], 'minimax-h3-fast')).toBe('minimax-h3-fast')
    expect(DEFAULT_VIDEO_MODELS[0]).toBe('grok-imagine-video-1.5')
  })

  it('lists only video models in the video mode', () => {
    const groups = [{ name: '图片模型', description: '', ratio: 1 }]
    const prepared = { 图片模型: { phase: 'ready' as const, models: ['gpt-image-2', 'grok-imagine-video-1.5', 'minimax-h3-base', 'gpt-test'] } }
    expect(buildChatCatalog(groups, prepared, 'video').map((entry) => entry.model).sort()).toEqual(['grok-imagine-video-1.5', 'minimax-h3-base'])
  })

  it('keeps a waiting video apart from a reply or an image that dies with the page', () => {
    const waiting = ask().conversation
    expect(isGeneratingVideo(waiting)).toBe(true)
    expect(isGeneratingReply(waiting)).toBe(false)
    expect(isGeneratingImage(waiting)).toBe(false)
    expect(isGenerating(waiting)).toBe(true)
    const text = createConversation(undefined, 'conversation-text')
    text.settings = { ...text.settings, group: 'group-a', model: 'gpt-test' }
    const answering = planTurn(text, { prompt: 'hi', requestId: 'request-text', assistantId: 'assistant-text', userMessageId: 'user-text' }).conversation
    expect(isGeneratingReply(answering)).toBe(true)
    expect(isGeneratingVideo(answering)).toBe(false)
    const done = { ...waiting, messages: waiting.messages.map((message) => message.role === 'assistant' ? completeChatVideo(message, clip) : message) }
    expect(isGeneratingVideo(done)).toBe(false)
    // 断网那句只催人停文字回复：视频停了也省不下钱。
    expect(shouldShowOfflineReplyNotice(reply(waiting), true)).toBe(false)
    expect(shouldShowOfflineReplyNotice(reply(answering), true)).toBe(true)
  })
})

describe('v2 chat video request', () => {
  it('asks for the shape, length and start image the composer shows', () => {
    const settings = videoConversation({ videoAspect: '9:16', videoSeconds: 8 }).settings
    const request = buildChatVideoRequest(settings, '  一只橘猫  ', image.assetId, 'request-video-1')
    expect(request).toMatchObject({ requestId: 'request-video-1', group: '图片模型', model: 'grok-imagine-video-1.5', prompt: '一只橘猫', seconds: '8', imageAssetIds: [image.assetId] })
    expect(buildChatVideoRequest(settings, '一只橘猫', undefined, 'request-video-2')).not.toHaveProperty('imageAssetIds')
    expect(buildChatVideoRequest(videoConversation({ model: 'minimax-h3-base', videoAspect: '1:1' }).settings, '一只橘猫', image.assetId, 'r')).toMatchObject({ mode: 'i2va', aspectRatio: '1:1' })
  })

  it('moves a remembered length the model cannot make to the nearest one it can', () => {
    // MiniMax 最短 5 秒：从 Grok 换过来时记着的 3 秒挪到 5 秒，确认框和请求用的是同一个数。
    const settings = videoConversation({ model: 'minimax-h3-base', videoSeconds: 3 }).settings
    expect(chatVideoSecondsFor(settings)).toBeGreaterThanOrEqual(5)
    expect(buildChatVideoRequest(settings, '一只橘猫', undefined, 'r').seconds).toBe(String(chatVideoSecondsFor(settings)))
    expect(chatVideoSecondsChoices('minimax-h3-base').every((seconds) => seconds >= 5)).toBe(true)
    expect(chatVideoSecondsChoices('grok-imagine-video-1.5')).toContain(chatVideoSecondsFor(videoConversation().settings))
    // 模型还没定：照记着的。
    expect(chatVideoSecondsFor({ model: '', videoSeconds: 3 })).toBe(3)
  })

  it('caps the clips made at once with a line that says so', () => {
    expect(maxParallelChatVideos).toBe(3)
    expect(chatVideoBusyMessage).toBe('已有 3 段视频正在生成，请等待其中一段完成后再发送')
  })
})

describe('v2 chat video settling', () => {
  const waiting = () => reply(ask().conversation)

  it('finishes with the clip and forgets the request id', () => {
    const done = completeChatVideo({ ...waiting(), error: 'old', mayStillComplete: true }, clip)
    expect(done).toMatchObject({ status: 'complete', video: { clip } })
    expect(done).not.toHaveProperty('requestId')
    expect(done).not.toHaveProperty('error')
    expect(done).not.toHaveProperty('mayStillComplete')
    const settled = { ...done, status: 'complete' as const }
    expect(completeChatVideo(settled, { ...clip, assetId: 'w'.repeat(43) })).toBe(settled)
  })

  it('counts a stop before submission as stopped, with nothing left to pick up', () => {
    const stopped = settleChatVideo(waiting())
    expect(stopped.status).toBe('canceled')
    expect(stopped.video).toEqual({})
    expect(stopped).not.toHaveProperty('requestId')
    expect(chatVideoRetry(stopped)).toEqual({ kind: 'fresh' })
  })

  it('keeps the request id after a failure that may still finish on the server, and asks for it first on retry', () => {
    const failed = settleChatVideo(waiting(), '暂时查不到进度，请稍后再看')
    expect(failed).toMatchObject({ status: 'error', error: '暂时查不到进度，请稍后再看', video: { requestId: 'request-video-1' } })
    expect(chatVideoRetry(failed)).toEqual({ kind: 'resume', requestId: 'request-video-1' })
  })

  it('forgets the request id once the main process says there is no such job', () => {
    const missing = settleChatVideo(waiting(), chatVideoFailedMessage, true)
    expect(missing).toMatchObject({ status: 'error', error: chatVideoFailedMessage, video: {} })
    expect(chatVideoRetry(missing)).toEqual({ kind: 'fresh' })
  })

  it('marks an ambiguous submission unconfirmed so a retry reuses the id and warns about paying twice', () => {
    const unsure = settleChatVideo(waiting(), aiVideoUnconfirmedSubmissionMessage)
    expect(unsure).toMatchObject({ status: 'error', error: aiVideoUnconfirmedSubmissionMessage, video: { requestId: 'request-video-1', unconfirmed: true } })
    expect(chatVideoRetry(unsure)).toEqual({ kind: 'reuse', requestId: 'request-video-1' })
    // Reused once and it failed again: still unconfirmed, whatever the new error says.
    const again = settleChatVideo({ ...waiting(), video: { requestId: 'request-video-1', unconfirmed: true } }, '网络连接失败')
    expect(again).toMatchObject({ error: '网络连接失败', video: { requestId: 'request-video-1', unconfirmed: true } })
    // Stopped while unconfirmed: it is not a free stop, so it keeps the warning instead of reading 已停止.
    const stopped = settleChatVideo({ ...waiting(), video: { requestId: 'request-video-1', unconfirmed: true } })
    expect(stopped).toMatchObject({ status: 'error', error: aiVideoUnconfirmedSubmissionMessage, video: { requestId: 'request-video-1', unconfirmed: true } })
  })

  it('treats a job the main process never recorded as unconfirmed only once it cannot be found', () => {
    const unrecorded = { ...waiting(), video: { requestId: 'request-video-1', unrecorded: true } }
    expect(settleChatVideo(unrecorded, '暂时查不到进度').video).toEqual({ requestId: 'request-video-1' })
    expect(settleChatVideo(unrecorded, chatVideoFailedMessage, true)).toMatchObject({ status: 'error', error: aiVideoUnconfirmedSubmissionMessage, video: { requestId: 'request-video-1', unconfirmed: true } })
  })

  it('leaves a reply that already settled alone', () => {
    const done = completeChatVideo(waiting(), clip)
    expect(settleChatVideo(done, 'late error')).toBe(done)
  })

  it('never offers a paid retry path for a reply that has its clip', () => {
    expect(chatVideoRetry({ ...waiting(), status: 'complete', video: { clip, requestId: 'left-over' } })).toEqual({ kind: 'fresh' })
    expect(chatVideoRetry(undefined)).toEqual({ kind: 'fresh' })
  })

  it('lists every reply still waiting across conversations so each can be resumed on open', () => {
    const state = createWorkspace('xm-account:7')
    const first = ask().conversation
    const second = { ...ask(videoConversation(), { requestId: 'request-video-2' }).conversation, id: 'conversation-other' }
    const finished = { ...first, id: 'conversation-done', messages: first.messages.map((message) => message.role === 'assistant' ? completeChatVideo(message, clip) : message) }
    state.conversations = [first, second, finished]
    expect(pendingChatVideos(state)).toEqual([
      { conversationId: 'conversation-video', messageId: 'assistant-video', requestId: 'request-video-1' },
      { conversationId: 'conversation-other', messageId: 'assistant-video', requestId: 'request-video-2' },
    ])
  })

  it('says plainly that a submitted clip cannot be stopped', () => {
    expect(chatVideoBilledNotice).toBe('该片段已提交至服务端并完成扣费，无法中止；将继续等待生成完成，完成后保留在此处。')
  })
})

describe('v2 chat video wording', () => {
  it('writes the progress the way the video workbench does', () => {
    expect(chatVideoProgressText(undefined)).toBe('正在生成视频')
    expect(chatVideoProgressText({ stage: 'processing', value: 42 })).toBe('正在生成视频 42%')
    expect(chatVideoProgressText({ stage: 'downloading' })).toBe('正在下载')
    expect(chatVideoProgressText({ stage: 'downloading', value: 80 })).toBe('正在下载 80%')
    expect(chatVideoProgressText({ stage: 'saving', value: 100 })).toBe('正在保存')
    expect(chatVideoProgressText({ stage: 'processing', value: 10, delayed: true })).toBe('排队较久')
  })

  it('shows size and length only when the main process measured them', () => {
    expect(chatVideoDetail(clip)).toBe('1280 × 720 · 5 秒')
    expect(chatVideoDetail({ ...clip, durationSeconds: undefined })).toBe('1280 × 720')
    expect(chatVideoDetail({ assetId, thumbnailUrl: clip.thumbnailUrl, durationSeconds: 5.4 })).toBe('5 秒')
    expect(chatVideoDetail({ assetId, thumbnailUrl: clip.thumbnailUrl })).toBe('')
    expect(chatVideoDuration(clip)).toBe('0:05')
    expect(chatVideoDuration({ ...clip, durationSeconds: 75.2 })).toBe('1:15')
    expect(chatVideoDuration({ ...clip, durationSeconds: 0.2 })).toBe('')
  })
})

describe('v2 chat video handed to a film', () => {
  function finished(images?: AiChatAsset[]): Conversation {
    const plan = ask(videoConversation({ videoAspect: '9:16', videoSeconds: 8 }), images ? { images } : {})
    return { ...plan.conversation, messages: plan.conversation.messages.map((message) => message.role === 'assistant' ? completeChatVideo(message, clip) : message) }
  }

  it('finds the prompt and start image the clip was made from', () => {
    expect(chatVideoSource(finished([image]), 'assistant-video')).toEqual({ prompt: '一只橘猫在雨里慢慢走', clip, imageAssetId: image.assetId })
    expect(chatVideoSource(finished(), 'assistant-video')).toEqual({ prompt: '一只橘猫在雨里慢慢走', clip })
    expect(chatVideoSource(finished(), 'missing')).toBeNull()
    expect(chatVideoSource(ask().conversation, 'assistant-video')).toBeNull()
  })

  it('takes the shape and length from the clip itself and the model from the video settings it was made with', () => {
    const settings = videoConversation({ videoAspect: '9:16', videoSeconds: 8 }).settings
    // 片段量出来是横的 5 秒：以它为准，不照设置里记的竖屏 8 秒。
    expect(chatVideoMade(settings, clip)).toEqual({ aspect: '16:9', model: 'grok-imagine-video-1.5', group: '图片模型', seconds: 5 })
    expect(chatVideoMade(settings, { ...clip, width: 720, height: 1280 }).aspect).toBe('9:16')
    expect(chatVideoMade(settings, { ...clip, width: 512, height: 512 }).aspect).toBe('1:1')
    expect(chatVideoMade(settings, { assetId, thumbnailUrl: clip.thumbnailUrl })).toMatchObject({ aspect: '9:16', seconds: 8 })
  })

  it('does not pass a chat or image model off as the video model', () => {
    const text = createConversation(undefined, 'conversation-text').settings
    expect(chatVideoMade({ ...text, group: 'GPT', model: 'gpt-5.6-sol' }, clip)).toMatchObject({ model: '', group: '' })
  })
})

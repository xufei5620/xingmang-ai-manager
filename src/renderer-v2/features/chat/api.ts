import type { AiChatHistoryWrite, AiChatImageInput, AiChatStartInput, AiVideoGenerateInput, ChatConversationExportInput, XingmangApi } from '../../../../electron/ipc-contract'
import { AI_CHAT_LIMITS, buildChatCompletionsRequest, buildImageGenerationRequest, resolveAiModelCapability, supportsChatImageInput } from '../../../../electron/ai-chat-protocol'
import { chatHistoryLogger } from './storage'

export type ChatBridge = Pick<XingmangApi, 'listAiChatGroups' | 'prepareAiChatGroup' | 'startAiChat' | 'generateAiImage' | 'cancelAiChat' | 'onAiChatStream' | 'copyAiChatAsset' | 'saveAiChatAsset' | 'showAiChatAssetMenu' | 'pickAiChatImages' | 'pickAiChatTextFiles' | 'pasteAiChatImage' | 'readAiChatHistory' | 'writeAiChatHistory' | 'exportAiChatConversation' | 'getAccountSession' | 'reportRendererError'>
// 「生成视频」那一档用的通道（融合第 2 步），都是视频工作台已经在用的那几条。只有「创作」页给得出；
// 单独摆着的聊天页（夹具）没有，那一档就不出现。
export type ChatVideoBridge = Pick<XingmangApi, 'generateAiVideo' | 'resumeAiVideo' | 'cancelAiVideo' | 'onAiVideoProgress' | 'openAiVideo' | 'saveAiVideo'>

export function createChatApi(bridge: ChatBridge & Partial<ChatVideoBridge>) {
  const video = bridge.generateAiVideo && bridge.resumeAiVideo && bridge.cancelAiVideo && bridge.onAiVideoProgress && bridge.openAiVideo && bridge.saveAiVideo
    ? createChatVideoApi({ generateAiVideo: bridge.generateAiVideo, resumeAiVideo: bridge.resumeAiVideo, cancelAiVideo: bridge.cancelAiVideo, onAiVideoProgress: bridge.onAiVideoProgress, openAiVideo: bridge.openAiVideo, saveAiVideo: bridge.saveAiVideo })
    : null
  return {
    video,
    listGroups: () => bridge.listAiChatGroups(),
    prepareGroup: (group: string) => bridge.prepareAiChatGroup(group),
    start: (input: AiChatStartInput) => { buildChatCompletionsRequest(input); return bridge.startAiChat(input) },
    generateImage: (input: AiChatImageInput) => { buildImageGenerationRequest(input); if (input.sourceAssetIds?.length && !canEditImages(input.model)) throw new Error(noImageEditModelMessage); return bridge.generateAiImage(input) },
    cancel: (requestId: string) => bridge.cancelAiChat(requestId),
    subscribe: (listener: Parameters<ChatBridge['onAiChatStream']>[0]) => bridge.onAiChatStream(listener),
    copyAsset: (assetId: string) => bridge.copyAiChatAsset(assetId),
    saveAsset: (assetId: string) => bridge.saveAiChatAsset(assetId),
    assetMenu: (assetId: string) => bridge.showAiChatAssetMenu(assetId),
    pickImages: (remaining: number) => bridge.pickAiChatImages(remaining),
    pasteImages: (remaining: number) => bridge.pasteAiChatImage(remaining),
    pickTextFiles: (remainingFiles: number, remainingCharacters: number) => bridge.pickAiChatTextFiles(remainingFiles, remainingCharacters),
    readHistory: (scope: string) => bridge.readAiChatHistory(scope),
    writeHistory: (input: AiChatHistoryWrite) => bridge.writeAiChatHistory(input),
    logHistoryProblem: chatHistoryLogger(bridge),
    exportText: (input: ChatConversationExportInput) => bridge.exportAiChatConversation(input),
    copyText: async (text: string) => { await navigator.clipboard.writeText(text) },
    readSession: () => bridge.getAccountSession(),
  }
}

function createChatVideoApi(bridge: ChatVideoBridge) {
  return {
    generate: (input: AiVideoGenerateInput) => bridge.generateAiVideo(input),
    // 只查不交：主进程按请求号找这一单，还在出就等它出完，查不到回 null。
    resume: (requestId: string) => bridge.resumeAiVideo(requestId),
    cancel: (requestId: string) => bridge.cancelAiVideo(requestId),
    subscribeProgress: (listener: Parameters<ChatVideoBridge['onAiVideoProgress']>[0]) => bridge.onAiVideoProgress(listener),
    open: (assetId: string) => bridge.openAiVideo(assetId),
    save: (assetId: string, suggestedName?: string) => bridge.saveAiVideo(assetId, suggestedName),
  }
}

export type ChatVideoApi = ReturnType<typeof createChatVideoApi>
export type ChatApi = ReturnType<typeof createChatApi>
export const chatLimits = AI_CHAT_LIMITS
export const inspectModel = resolveAiModelCapability
export const canReadImages = supportsChatImageInput
export const validateChatRequest = buildChatCompletionsRequest
export const validateImageRequest = buildImageGenerationRequest
export const noImageEditModelMessage = '这个模型不能照着图片改，请换一个能改图的模型，或者先把图片去掉'
// 能照着参考图改的出图模型（走 Images API 的 edits），主进程生图服务按同一张型号表再核一次。
export function canEditImages(model: string): boolean {
  try {
    const capability = resolveAiModelCapability(model)
    return capability.kind === 'image' && capability.available && capability.supportsEdits
  } catch { return false }
}
// 能从一张图开始出视频的视频模型（那张图当第一帧）。现在的视频模型都能，认不出的型号不放图进去。
export function canStartVideoFromImage(model: string): boolean {
  try {
    const capability = resolveAiModelCapability(model)
    return capability.kind === 'video' && capability.supportsImageInput
  } catch { return false }
}

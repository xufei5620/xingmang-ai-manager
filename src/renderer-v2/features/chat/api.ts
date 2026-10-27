import type { AiChatHistoryWrite, AiChatImageInput, AiChatStartInput, ChatConversationExportInput, XingmangApi } from '../../../../electron/ipc-contract'
import { AI_CHAT_LIMITS, buildChatCompletionsRequest, buildImageGenerationRequest, resolveAiModelCapability, supportsChatImageInput } from '../../../../electron/ai-chat-protocol'

export type ChatBridge = Pick<XingmangApi, 'listAiChatGroups' | 'prepareAiChatGroup' | 'startAiChat' | 'generateAiImage' | 'cancelAiChat' | 'onAiChatStream' | 'copyAiChatAsset' | 'saveAiChatAsset' | 'showAiChatAssetMenu' | 'pickAiChatImages' | 'pasteAiChatImage' | 'readAiChatHistory' | 'writeAiChatHistory' | 'exportAiChatConversation' | 'getAccountSession'>

export function createChatApi(bridge: ChatBridge) {
  return {
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
    pasteImage: () => bridge.pasteAiChatImage(),
    readHistory: (scope: string) => bridge.readAiChatHistory(scope),
    writeHistory: (input: AiChatHistoryWrite) => bridge.writeAiChatHistory(input),
    exportText: (input: ChatConversationExportInput) => bridge.exportAiChatConversation(input),
    copyText: async (text: string) => { await navigator.clipboard.writeText(text) },
    readSession: () => bridge.getAccountSession(),
  }
}

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

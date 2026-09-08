import type { AiChatStartInput, AiImageGenerateInput, XingmangApi } from '../../../../electron/ipc-contract'
import { AI_CHAT_LIMITS, buildChatCompletionsRequest, buildImageGenerationRequest, resolveAiModelCapability } from '../../../../electron/ai-chat-protocol'

export type ChatBridge = Pick<XingmangApi, 'listAiChatGroups' | 'prepareAiChatGroup' | 'startAiChat' | 'generateAiImage' | 'cancelAiChat' | 'onAiChatStream' | 'copyAiChatAsset' | 'saveAiChatAsset' | 'showAiChatAssetMenu' | 'openExternal' | 'getAccountSession'>

export function createChatApi(bridge: ChatBridge) {
  return {
    listGroups: () => bridge.listAiChatGroups(),
    prepareGroup: (group: string) => bridge.prepareAiChatGroup(group),
    start: (input: AiChatStartInput) => { buildChatCompletionsRequest(input); return bridge.startAiChat(input) },
    generateImage: (input: AiImageGenerateInput) => { buildImageGenerationRequest(input); return bridge.generateAiImage(input) },
    cancel: (requestId: string) => bridge.cancelAiChat(requestId),
    subscribe: (listener: Parameters<ChatBridge['onAiChatStream']>[0]) => bridge.onAiChatStream(listener),
    copyAsset: (assetId: string) => bridge.copyAiChatAsset(assetId),
    saveAsset: (assetId: string) => bridge.saveAiChatAsset(assetId),
    assetMenu: (assetId: string) => bridge.showAiChatAssetMenu(assetId),
    openExternal: (url: string) => bridge.openExternal(url),
    copyText: async (text: string) => { await navigator.clipboard.writeText(text) },
    readSession: () => bridge.getAccountSession(),
  }
}

export type ChatApi = ReturnType<typeof createChatApi>
export const chatLimits = AI_CHAT_LIMITS
export const inspectModel = resolveAiModelCapability
export const validateChatRequest = buildChatCompletionsRequest
export const validateImageRequest = buildImageGenerationRequest

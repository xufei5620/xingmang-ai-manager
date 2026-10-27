// 主窗口业务通道的处理器：AI 对话、生图、对话里的图片和聊天记录读写。
// #1070 第 7 步从 ipc.ts 原样搬来：按域一个文件，ipc.ts 只管组装，各域共用的东西在 context.ts。
import type { WebContents } from 'electron'
import { loadAccountGroupHints, markRecommendedChatGroup } from '../../managed-cli-groups'
import { parseAiChatHistoryScope, parseAiChatHistoryWrite } from '../../ai-chat-history-store'
import { requiredString } from '../parsers/common'
import { parseAiChatImageInput, parseAiChatStartInput } from '../parsers/ai-chat'
import type { IpcHandlerContext } from './context'

export function registerAiChatHandlers(ctx: IpcHandlerContext): void {
  const { options, registerTrustedHandler, accountService, automaticProvisioning } = ctx
  registerTrustedHandler('chat:list-groups', async () => {
    if (!options.chatCredentials) throw new Error('AI聊天服务未就绪')
    const [groups, hints] = await Promise.all([
      options.chatCredentials.listGroups(),
      loadAccountGroupHints(automaticProvisioning),
    ])
    return markRecommendedChatGroup(groups, accountService.getActiveSiteId?.(), hints)
  })
  registerTrustedHandler('chat:prepare-group', (_event, group: unknown) => {
    if (!options.chatCredentials) throw new Error('AI聊天服务未就绪')
    return options.chatCredentials.prepareGroup(requiredString(group, 'AI聊天分组', 128))
  })
  const observedChatSenders = new WeakSet<WebContents>()
  const observeChatSender = (sender: WebContents): void => {
    if (observedChatSenders.has(sender)) return
    observedChatSenders.add(sender)
    sender.once('destroyed', () => {
      options.chatService?.cancelSender(sender.id)
      options.imageService?.cancelSender(sender.id)
    })
  }
  const currentChatUserId = (): number => {
    const session = accountService.getSessionState()
    const userId = session.authenticated ? session.account?.userId : undefined
    if (!userId) throw new Error('请先登录星芒账号')
    return userId
  }
  registerTrustedHandler('chat:start', (event, input: unknown) => {
    if (!options.chatService) throw new Error('AI聊天服务未就绪')
    observeChatSender(event.sender)
    const parsed = parseAiChatStartInput(input)
    return options.chatService.start({ senderId: event.sender.id, ...parsed })
  })
  registerTrustedHandler('chat:generate-image', (event, input: unknown) => {
    if (!options.imageService) throw new Error('生图服务未就绪')
    observeChatSender(event.sender)
    const { sourceAssetIds, ...parsed } = parseAiChatImageInput(input)
    const request = { ...parsed, expectedUserId: currentChatUserId() }
    // 带了参考图就照图改，模型能不能改图由生图服务按型号表再核一次。
    return sourceAssetIds
      ? options.imageService.edit(event.sender.id, { ...request, sourceAssetIds })
      : options.imageService.generate(event.sender.id, request)
  })
  registerTrustedHandler('chat:cancel', (event, requestId: unknown) => {
    const id = requiredString(requestId, 'AI聊天请求标识', 160)
    const chatCanceled = options.chatService?.cancel(event.sender.id, id) ?? false
    const imageCanceled = options.imageService?.cancel(event.sender.id, id)
      ?? { canceled: false, mayStillComplete: false }
    return {
      canceled: chatCanceled || imageCanceled.canceled,
      mayStillComplete: imageCanceled.mayStillComplete,
    }
  })
  registerTrustedHandler('chat:copy-asset', (_event, assetId: unknown) => {
    if (!options.aiAssets) throw new Error('AI 图片服务未就绪')
    return options.aiAssets.copy(currentChatUserId(), requiredString(assetId, 'AI 图片资产标识', 160))
  })
  registerTrustedHandler('chat:save-asset', async (_event, assetId: unknown) => {
    if (!options.aiAssets) throw new Error('AI 图片服务未就绪')
    return {
      saved: await options.aiAssets.saveAs(
        currentChatUserId(),
        requiredString(assetId, 'AI 图片资产标识', 160),
      ),
    }
  })
  registerTrustedHandler('chat:asset-menu', (_event, assetId: unknown) => {
    if (!options.aiAssets) throw new Error('AI 图片服务未就绪')
    const userId = currentChatUserId()
    return options.aiAssets.contextMenu(
      userId,
      requiredString(assetId, 'AI 图片资产标识', 160),
      () => {
        if (currentChatUserId() !== userId) throw new Error('账号已切换，请重新打开图片菜单')
      },
    )
  })
  // The picker and the clipboard are read here, never handed in by the
  // renderer, so a compromised page cannot make the main process read an
  // arbitrary path (same reasoning as the canvas' single drop channel).
  registerTrustedHandler('chat:pick-images', (_event, remaining: unknown) => {
    if (!options.chatAttachments) throw new Error('聊天图片服务未就绪')
    if (typeof remaining !== 'number' || !Number.isSafeInteger(remaining)) throw new Error('聊天图片数量格式错误')
    return options.chatAttachments.pick(currentChatUserId(), remaining)
  })
  registerTrustedHandler('chat:paste-image', () => {
    if (!options.chatAttachments) throw new Error('聊天图片服务未就绪')
    return options.chatAttachments.paste(currentChatUserId())
  })
  // Deliberately outside the chat: account gate. The window saves the old
  // account's last edits while an account switch is in progress, and history
  // was never tied to the live session (it used to sit in localStorage).
  registerTrustedHandler('chat-history:read', (_event, scope: unknown) => {
    if (!options.chatHistory) throw new Error('聊天记录存储未就绪')
    return options.chatHistory.read(parseAiChatHistoryScope(scope))
  })
  registerTrustedHandler('chat-history:write', (_event, input: unknown) => {
    if (!options.chatHistory) throw new Error('聊天记录存储未就绪')
    return options.chatHistory.write(parseAiChatHistoryWrite(input))
  })
}

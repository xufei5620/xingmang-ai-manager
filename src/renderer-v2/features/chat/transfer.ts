import type { XingmangApi } from '../../../../electron/ipc-contract'
import type { Conversation } from './state'
import { exportableConversations, importConversationsIntoHistory, loadChatHistory, settleHistoryWrites, type ChatStorage } from './storage'

/** 设置页「搬到新电脑」里聊天记录那一半，只在登录后才有（聊天记录按账号分开存）。 */
export interface ChatTransfer {
  exportConversations: () => Promise<unknown[]>
  importConversations: (conversations: Conversation[]) => Promise<number>
}

export type ChatTransferBridge = Pick<XingmangApi, 'readAiChatHistory' | 'writeAiChatHistory'>

/**
 * unmountChat must take the chat page down synchronously: while it is mounted
 * it holds its own idea of what is saved, and its next autosave would drop the
 * imported conversations again. It reloads from the files the next time the
 * chat page opens.
 */
export function createChatTransfer(bridge: ChatTransferBridge, storage: ChatStorage, scope: string, unmountChat: () => void): ChatTransfer {
  const api = {
    readHistory: (owner: string) => bridge.readAiChatHistory(owner),
    writeHistory: bridge.writeAiChatHistory,
  }
  return {
    async exportConversations() {
      await settleHistoryWrites()
      const loaded = await loadChatHistory(api, storage, scope)
      if (loaded.warning) throw new Error(`${loaded.warning}，这次没有导出`)
      return exportableConversations(loaded.state)
    },
    async importConversations(conversations) {
      if (!conversations.length) return 0
      unmountChat()
      await settleHistoryWrites()
      return importConversationsIntoHistory(api, storage, scope, conversations)
    },
  }
}

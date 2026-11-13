import type { XingmangApi } from '../../../../electron/ipc-contract'
import { activeRestartWork } from '../../background-work'
import type { Conversation } from './state'
import { chatHistoryLogger, exportableConversations, exportablePhrases, importConversationsIntoHistory, loadChatHistory, runHistoryImport, settleHistoryWrites, type ChatImportResult, type ChatStorage } from './storage'

/**
 * D41：导入要先把聊天页卸下，卸下就把正在回复、出图的那条掐断（出图那条可能照样扣了费）。
 * 聊天在回复时先不动，说这一句。
 */
export const chatReplyingImportMessage = '聊天正在回复，等它说完再导入。'

/**
 * 设置页「搬到新电脑」里聊天记录那一半，只在登录后才有（聊天记录按账号分开存）。
 * 聊天页「常用的话」跟聊天记录存在一起，也跟着走。
 */
export interface ChatTransfer {
  exportChat: () => Promise<{ conversations: unknown[]; phrases: string[] }>
  /** 聊天在回复或出图时抛错（D41）。设置页选文件之前先问一次，什么都还没动。 */
  assertChatIdle: () => void
  importConversations: (conversations: Conversation[], phrases?: readonly string[]) => Promise<ChatImportResult>
}

// 聊天页回复或出图时登记的是 'chat'（ChatPage.tsx 的 useBackgroundWork）。聊天页藏在别的页面后面时照样登记着。
function assertChatIdle(): void {
  if (activeRestartWork().includes('chat')) throw new Error(chatReplyingImportMessage)
}

export type ChatTransferBridge = Pick<XingmangApi, 'readAiChatHistory' | 'writeAiChatHistory'> & Partial<Pick<XingmangApi, 'reportRendererError'>>

/**
 * unmountChat must take the chat page down synchronously: while it is mounted
 * it holds its own idea of what is saved, and its next autosave would drop the
 * imported conversations again. A chat page shown at the time comes straight
 * back; it, and any opened while the import runs, reads the files only once
 * the import is saved (runHistoryImport).
 */
export function createChatTransfer(bridge: ChatTransferBridge, storage: ChatStorage, scope: string, unmountChat: () => void): ChatTransfer {
  const api = {
    readHistory: (owner: string) => bridge.readAiChatHistory(owner),
    writeHistory: bridge.writeAiChatHistory,
    ...(bridge.reportRendererError ? { logHistoryProblem: chatHistoryLogger({ reportRendererError: bridge.reportRendererError }) } : {}),
  }
  return {
    async exportChat() {
      await settleHistoryWrites()
      const loaded = await loadChatHistory(api, storage, scope)
      if (loaded.warning) throw new Error(`${loaded.warning}，这次没有导出`)
      return { conversations: exportableConversations(loaded.state), phrases: exportablePhrases(loaded.state) }
    },
    assertChatIdle,
    async importConversations(conversations, phrases = []) {
      if (!conversations.length && !phrases.length) return { added: 0, updated: 0, skipped: 0 }
      // 卸下聊天页前再看一次：设置页先问的那次跟这里隔着选文件、问要不要换掉设置，都要等人。
      assertChatIdle()
      return runHistoryImport(scope, async () => {
        unmountChat()
        await settleHistoryWrites()
        return importConversationsIntoHistory(api, storage, scope, conversations, phrases)
      })
    },
  }
}

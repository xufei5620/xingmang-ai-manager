import type { VideoStudioProjectFile, XingmangApi } from '../../../../electron/ipc-contract'
import { activeRestartWork } from '../../background-work'
import { runVideoStudioImport } from '../video-studio/library'
import { exportableVideoStudioProjects, importVideoStudioProjects } from '../video-studio/transfer'
import type { Conversation } from './state'
import { chatHistoryLogger, exportableConversations, exportablePhrases, flushChatHistory, importConversationsIntoHistory, loadChatHistory, runHistoryImport, settleHistoryWrites, type ChatImportResult, type ChatStorage, type ChatTransferOptions } from './storage'

/**
 * D41：导入要先把聊天页卸下，卸下就把正在回复、出图的那条掐断（出图那条可能照样扣了费）。
 * 聊天在回复时先不动，说这一句。
 */
export const chatReplyingImportMessage = '聊天正在回复，请待回复完成后再导入。'

/** 导入的结果：对话那几个数，加上「创作」里的视频导进来几条、放不下几条。 */
export interface ChatTransferImportResult extends ChatImportResult {
  videosAdded: number
  videosSkipped: number
}

/**
 * 设置页「迁移到新电脑」里聊天记录那一半，只在登录后才有（聊天记录按账号分开存）。
 * 聊天页「常用的话」跟聊天记录存在一起，也跟着走；「创作」里的视频（分镜）跟聊天页挂在同一页上，
 * 一起卸下、一起导（「搬作品改」）。
 */
export interface ChatTransfer {
  /** withWorks：作品库一起导出，对话里的图片、视频原样带上（chat/storage.ts 的 ChatTransferOptions）。 */
  exportChat: (options?: ChatTransferOptions) => Promise<{ conversations: unknown[]; phrases: string[]; videoProjects: VideoStudioProjectFile[] }>
  /** 聊天在回复或出图时抛错（D41）。设置页选文件之前先问一次，什么都还没动。 */
  assertChatIdle: () => void
  importConversations: (conversations: Conversation[], phrases?: readonly string[], videoProjects?: readonly VideoStudioProjectFile[]) => Promise<ChatTransferImportResult>
  /**
   * 作品导进来以后把「创作」重新挂一次，对话里原来显示不出来的图、作品库里的作品当场换成导进来的。
   * 聊天正在回复、出图时不动（D41），那时客户切过去时自己会读到新的。
   */
  reloadCreate: () => void
}

// 聊天页回复或出图时登记的是 'chat'（ChatPage.tsx 的 useBackgroundWork）。聊天页藏在别的页面后面时照样登记着。
function assertChatIdle(): void {
  if (activeRestartWork().includes('chat')) throw new Error(chatReplyingImportMessage)
}

export type ChatTransferBridge = Pick<XingmangApi, 'readAiChatHistory' | 'writeAiChatHistory' | 'readVideoStudioProjects' | 'writeVideoStudioProjects'> & Partial<Pick<XingmangApi, 'reportRendererError'>>

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
    async exportChat(options = {}) {
      // 导出读的是存到本机的那份。聊天页自动保存最多晚 2 秒（autosaveMaxWaitMs），回复刚说完就来导出，
      // 以前只等正在写的那次，最后一问一答还在聊天页手上没存，导出的文件里就没有（0.2.24 Mac 验收 R6）。
      // 所以先跟退出前一样让开着的聊天页马上存一次；存失败了原来的文件没动，照旧导出存着的那份。
      await flushChatHistory()
      await settleHistoryWrites()
      const loaded = await loadChatHistory(api, storage, scope)
      if (loaded.warning) throw new Error(`${loaded.warning}，本次未导出`)
      // 视频那一页也登记在 flushChatHistory 里（useVideoStudioLibrary），上面那一下已经把手上攒着的存下了。
      const videos = await bridge.readVideoStudioProjects(scope)
      return { conversations: exportableConversations(loaded.state, options), phrases: exportablePhrases(loaded.state), videoProjects: exportableVideoStudioProjects(videos.projects) }
    },
    assertChatIdle,
    async importConversations(conversations, phrases = [], videoProjects = []) {
      if (!conversations.length && !phrases.length && !videoProjects.length) return { added: 0, updated: 0, skipped: 0, videosAdded: 0, videosSkipped: 0 }
      // 卸下聊天页前再看一次：设置页先问的那次跟这里隔着选文件、问要不要换掉设置，都要等人。
      assertChatIdle()
      // 视频那一边的登记要在卸下之前：重新挂上的「创作」一挂上就读视频，得等这边写完。
      return runVideoStudioImport(scope, () => runHistoryImport(scope, async () => {
        unmountChat()
        await settleHistoryWrites()
        const chat = await importConversationsIntoHistory(api, storage, scope, conversations, phrases)
        const videos = await importVideoStudioProjects(bridge, scope, videoProjects)
        return { ...chat, videosAdded: videos.added, videosSkipped: videos.skipped }
      }))
    },
    reloadCreate() {
      if (!activeRestartWork().includes('chat')) unmountChat()
    },
  }
}

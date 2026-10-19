// 主窗口业务通道的处理器：导出这段对话、「搬到新电脑」的导出与导入。
// #1070 第 7 步从 ipc.ts 原样搬来：按域一个文件，ipc.ts 只管组装，各域共用的东西在 context.ts。
import { dialog } from 'electron'
import os from 'node:os'
import path from 'node:path'
import { writeAtomicSafeUtf8File } from '../../safe-local-data'
import { readBoundedUtf8File } from '../../bounded-file'
import {
  buildDataTransferFile,
  conversationFileName,
  dataTransferFileName,
  dataTransferInvalidMessage,
  MAX_DATA_TRANSFER_BYTES,
  parseChatConversationExport,
  parseDataTransferExportInput,
  parseDataTransferFile,
  planPortableSettingsImport,
} from '../../data-transfer'
import type { IpcHandlerContext } from './context'

export function registerDataTransferHandlers(ctx: IpcHandlerContext): void {
  const { options, registerTrustedHandler, service, rememberExportedFile } = ctx
  function desktopDirectory(): string {
    try {
      if (options.desktopDirectory) return options.desktopDirectory()
    } catch {
      // app.getPath 拿不到桌面时退到主目录下的 Desktop，保存框里用户还能自己换。
    }
    return path.join(os.homedir(), 'Desktop')
  }
  registerTrustedHandler('chat-history:export-text', async (_event, input: unknown) => {
    const { title, text } = parseChatConversationExport(input)
    const result = await dialog.showSaveDialog({
      title: '导出这段对话',
      defaultPath: path.join(desktopDirectory(), conversationFileName(title)),
      filters: [{ name: '文本文件', extensions: ['txt'] }],
    })
    if (result.canceled || !result.filePath) return null
    await writeAtomicSafeUtf8File(result.filePath, text, '聊天对话导出文件')
    rememberExportedFile(result.filePath)
    return { outputPath: result.filePath }
  })
  // 「搬到新电脑」：设置由这里自己从 settings.json 挑，渲染层只交对话；文件里没有 Key、
  // 密码和登录状态（data-transfer.ts）。
  registerTrustedHandler('data-transfer:export', async (_event, input: unknown) => {
    const exportInput = parseDataTransferExportInput(input)
    const now = new Date()
    const content = buildDataTransferFile(service.readStoredConfig(), exportInput, now)
    const result = await dialog.showSaveDialog({
      title: '导出聊天记录和设置',
      defaultPath: path.join(desktopDirectory(), dataTransferFileName(now)),
      filters: [{ name: '星芒聊天记录与设置', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePath) return null
    await writeAtomicSafeUtf8File(result.filePath, content, '聊天记录与设置导出文件')
    rememberExportedFile(result.filePath)
    return { outputPath: result.filePath, conversations: exportInput.conversations.length }
  })
  // 只读、只解析，什么都不写：对话交给渲染层逐条校验后合并，设置由渲染层走 settings:save，
  // 改过的那几项先问用户。
  registerTrustedHandler('data-transfer:import', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择导出的聊天记录和设置',
      properties: ['openFile'],
      filters: [{ name: '星芒聊天记录与设置', extensions: ['json'] }],
    })
    const filePath = result.canceled ? undefined : result.filePaths[0]
    if (!filePath) return null
    let raw: string
    try {
      raw = await readBoundedUtf8File(filePath, MAX_DATA_TRANSFER_BYTES, '聊天记录与设置文件')
    } catch {
      // 太大、是链接、读不了：对用户都是「这不是一份能导入的文件」。
      throw new Error(dataTransferInvalidMessage)
    }
    const parsed = parseDataTransferFile(raw)
    return { conversations: parsed.conversations, ...planPortableSettingsImport(service.readStoredConfig(), parsed.settings) }
  })
}

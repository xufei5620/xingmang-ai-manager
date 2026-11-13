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
  dataTransferReadFailureMessage,
  MAX_DATA_TRANSFER_BYTES,
  parseChatConversationExport,
  parseDataTransferExportInput,
  parseDataTransferFile,
  planPortableSettingsImport,
} from '../../data-transfer'
import type { IpcHandlerContext } from './context'

export function registerDataTransferHandlers(ctx: IpcHandlerContext): void {
  const { options, registerTrustedHandler, service, rememberExportedFile } = ctx
  // 默认存到「下载」，不存桌面（D16）：Windows「受控文件夹访问」默认保护桌面、不保护下载。
  // 星芒没签名，开着它的电脑上多半不在放行名单里（推测），往桌面导出会被拦。
  function downloadsDirectory(): string {
    try {
      if (options.downloadsDirectory) return options.downloadsDirectory()
    } catch {
      // app.getPath 拿不到「下载」时退到主目录下的 Downloads，保存框里用户还能自己换。
    }
    return path.join(os.homedir(), 'Downloads')
  }
  // 「匿名使用统计」在系统界面设置那份文件里（X-3）。没接上或读的时候出错都按读不出来算：导出不带、导入不碰。
  function anonymousUsageHere(): boolean | null {
    try {
      return options.readAnonymousUsagePreference?.() ?? null
    } catch {
      return null
    }
  }
  registerTrustedHandler('chat-history:export-text', async (_event, input: unknown) => {
    const { title, text } = parseChatConversationExport(input)
    const result = await dialog.showSaveDialog({
      title: '导出这段对话',
      defaultPath: path.join(downloadsDirectory(), conversationFileName(title)),
      filters: [{ name: '文本文件', extensions: ['txt'] }],
    })
    if (result.canceled || !result.filePath) return null
    await writeAtomicSafeUtf8File(result.filePath, text, '聊天对话导出文件')
    rememberExportedFile(result.filePath)
    return { outputPath: result.filePath }
  })
  // 「搬到新电脑」：设置由这里自己从 settings.json 和系统界面设置里挑，渲染层只交对话；文件里没有 Key、
  // 密码和登录状态（data-transfer.ts）。
  registerTrustedHandler('data-transfer:export', async (_event, input: unknown) => {
    const exportInput = parseDataTransferExportInput(input)
    const now = new Date()
    const content = buildDataTransferFile(service.readStoredConfig(), exportInput, now, anonymousUsageHere())
    const result = await dialog.showSaveDialog({
      title: '导出聊天记录和设置',
      defaultPath: path.join(downloadsDirectory(), dataTransferFileName(now)),
      filters: [{ name: '星芒聊天记录与设置', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePath) return null
    await writeAtomicSafeUtf8File(result.filePath, content, '聊天记录与设置导出文件')
    rememberExportedFile(result.filePath)
    return { outputPath: result.filePath, conversations: exportInput.conversations.length }
  })
  // 只读、只解析，什么都不写：对话交给渲染层逐条校验后合并，设置由渲染层走 settings:save（匿名使用统计
  // 走系统界面设置那条），改过的那几项先问用户。
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
    } catch (error) {
      // 被占着、没权限单独说一句；太大、是链接照旧是「这不是一份能导入的文件」。原话挂在 cause 上进运行日志。
      throw new Error(dataTransferReadFailureMessage(error), { cause: error })
    }
    const parsed = parseDataTransferFile(raw)
    return {
      conversations: parsed.conversations,
      phrases: parsed.phrases,
      ...planPortableSettingsImport(service.readStoredConfig(), parsed.settings, { here: anonymousUsageHere(), incoming: parsed.anonymousUsage }),
    }
  })
}

import type { AppSettingsV2Update, DataTransferExportResult, DataTransferImportPreview } from '../../../../electron/ipc-contract'
import { MAX_CONVERSATIONS } from '../chat/storage'

// 设置页「搬到新电脑」的说法。放在这里是为了能单测，页面只管调用。

function fileNameOf(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath
}

export function dataTransferExportMessage(result: DataTransferExportResult): string {
  const content = result.conversations ? `${result.conversations} 个对话及设置` : '设置'
  return `已保存「${fileNameOf(result.outputPath)}」，包含${content}。复制到新电脑后，请在此点击「导入」。`
}

/** 主进程给的设置更新去掉 version，交给设置页的保存队列；没有要改的返回 null。 */
export function settingsPatchFrom(...updates: AppSettingsV2Update[]): Omit<AppSettingsV2Update, 'version'> | null {
  const patch: Omit<AppSettingsV2Update, 'version'> = {}
  for (const { version: _version, ...rest } of updates) Object.assign(patch, rest)
  return Object.keys(patch).length ? patch : null
}

/**
 * 这次要写的「匿名使用统计」（X-3），没有要改的返回 undefined。overwrite = 询问框里点了「使用文件中的设置」；
 * 点「保留本机设置」时这台关过的照旧关着。
 */
export function anonymousUsageFrom(
  preview: Pick<DataTransferImportPreview, 'anonymousUsage' | 'conflictingAnonymousUsage'>,
  overwrite: boolean,
): boolean | undefined {
  if (overwrite && preview.conflictingAnonymousUsage !== undefined) return preview.conflictingAnonymousUsage
  return preview.anonymousUsage
}

export interface DataTransferImportOutcome {
  /** 文件里有几个对话。 */
  fileConversations: number
  /** 导进来的新对话（这台电脑上已有的不算；两边各聊过、另存的那一份算）。 */
  added: number
  /** 这台电脑上已有、旧电脑上又接着聊过，换成了文件里那份的对话（设置 X-4）。 */
  updated: number
  /** 这台电脑存满 MAX_CONVERSATIONS 个对话、这次放不下的新对话。本机的对话不会为了它们被删掉。 */
  skipped: number
  signedIn: boolean
  settingsChanged: boolean
}

const deleteThenRetry = '请在「创作」中删除部分不需要的记录，再次点击「导入」。'

export function dataTransferImportMessage(outcome: DataTransferImportOutcome): string {
  const { fileConversations, added, updated, skipped, signedIn, settingsChanged } = outcome
  if (fileConversations && !signedIn) {
    return `${settingsChanged ? '设置已导入。' : ''}文件中的 ${fileConversations} 个对话需登录后再次点击「导入」。`
  }
  if (!fileConversations) return settingsChanged ? '已导入设置。' : '文件中的设置与本机一致，无需修改。'
  const alsoUpdated = updated ? `，另有 ${updated} 个对话已更新为文件中的内容` : ''
  if (skipped && added) {
    return `已导入 ${added} 个对话${settingsChanged ? '及设置' : ''}${alsoUpdated}。另有 ${skipped} 个未导入：本机最多保存 ${MAX_CONVERSATIONS} 个对话，${deleteThenRetry}`
  }
  if (skipped) {
    return `${settingsChanged ? '设置已导入。' : ''}${updated ? `${updated} 个对话已更新为文件中的内容。` : ''}本机已保存 ${MAX_CONVERSATIONS} 个对话（已达上限），文件中的 ${skipped} 个对话未导入。${deleteThenRetry}`
  }
  // 文件里的对话全都更新了，就没有「其余」可说。
  if (!added && updated) return `${updated} 个对话已更新为文件中的内容${updated < fileConversations ? '，其余已存在于本机' : ''}${settingsChanged ? '，设置已导入' : ''}。`
  if (!added) return `文件中的对话均已存在于本机${settingsChanged ? '，设置已导入' : ''}。`
  return `已导入 ${added} 个对话${settingsChanged ? '及设置' : ''}${alsoUpdated}。`
}

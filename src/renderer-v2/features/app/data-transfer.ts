import type { AppSettingsV2Update, DataTransferExportResult } from '../../../../electron/ipc-contract'

// 设置页「搬到新电脑」的说法。放在这里是为了能单测，页面只管调用。

function fileNameOf(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath
}

export function dataTransferExportMessage(result: DataTransferExportResult): string {
  const content = result.conversations ? `${result.conversations} 个对话和你的设置` : '你的设置'
  return `已存好「${fileNameOf(result.outputPath)}」，里面有${content}。拷到新电脑后，在这里点「导入」。`
}

/** 主进程给的设置更新去掉 version，交给设置页的保存队列；没有要改的返回 null。 */
export function settingsPatchFrom(...updates: AppSettingsV2Update[]): Omit<AppSettingsV2Update, 'version'> | null {
  const patch: Omit<AppSettingsV2Update, 'version'> = {}
  for (const { version: _version, ...rest } of updates) Object.assign(patch, rest)
  return Object.keys(patch).length ? patch : null
}

export interface DataTransferImportOutcome {
  /** 文件里有几个对话。 */
  fileConversations: number
  /** 导进来的新对话（这台电脑上已有的不算）。 */
  added: number
  /** 这台电脑存满 50 个对话、这次放不下的新对话。本机的对话不会为了它们被删掉。 */
  skipped: number
  signedIn: boolean
  settingsChanged: boolean
}

const deleteThenRetry = '在「聊天」里删掉一些不要的，再点一次「导入」就能补上。'

export function dataTransferImportMessage(outcome: DataTransferImportOutcome): string {
  const { fileConversations, added, skipped, signedIn, settingsChanged } = outcome
  if (fileConversations && !signedIn) {
    return `${settingsChanged ? '设置已导入。' : ''}文件里的 ${fileConversations} 个对话要先登录，再点一次「导入」。`
  }
  if (!fileConversations) return settingsChanged ? '导入了你的设置。' : '文件里的设置和这台电脑上的一样，没有要改的。'
  if (skipped && added) {
    return `导入了 ${added} 个对话${settingsChanged ? '和你的设置' : ''}。还有 ${skipped} 个没导进来：这台电脑最多存 50 个对话，${deleteThenRetry}`
  }
  if (skipped) return `${settingsChanged ? '设置已导入。' : ''}这台电脑已经存满 50 个对话，文件里的 ${skipped} 个对话没导进来。${deleteThenRetry}`
  if (!added) return `文件里的对话这台电脑上都有了${settingsChanged ? '，设置已导入' : ''}。`
  return `导入了 ${added} 个对话${settingsChanged ? '和你的设置' : ''}。`
}

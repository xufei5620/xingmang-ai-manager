import fs from 'node:fs'

// D29（推测，没在真机上核）：Mac 上「桌面」「文稿」「下载」受系统保护，星芒自己查里面的
// 文件夹在不在也要过「文件和文件夹」授权。客户点过「不允许」以后，stat 拿到的是 EPERM /
// EACCES，文件夹其实还在；以前 existsSync 把它当成「不存在」，客户重新选同一个文件夹，
// 下次重开星芒又报。终端那边的授权另算（cli-exit-hint.ts），所以这句让客户两项都打开。
export const macosWorkspaceAccessDeniedMessage = 'Mac 没允许星芒打开这个文件夹。打开「系统设置 › 隐私与安全性 › 文件和文件夹」，把「星芒AI管理工具」和「终端」两项都打开，再点一次「打开」。'

function isAccessDenied(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EPERM' || code === 'EACCES'
}

/**
 * 打开工具前查一次工作目录。不在、不是文件夹，报 missingMessage：界面认的是这句里的
 * 「工作目录不存在」，认出来就退回目录选择器（recent-workspaces.ts 的 isMissingWorkspace）。
 * Mac 上不让看时报上面那句，不退回选择器：换个文件夹解决不了授权，重选同一个下次照样报。
 * Windows、Linux 不让看照旧当成不存在，跟以前 existsSync 的结果一样。
 */
export function assertWorkspaceDirectory(
  workspace: string,
  platform: NodeJS.Platform,
  missingMessage: string,
  statSync: (target: string) => fs.Stats = fs.statSync,
): void {
  let stats: fs.Stats
  try {
    stats = statSync(workspace)
  } catch (error) {
    if (platform === 'darwin' && isAccessDenied(error)) {
      throw new Error(macosWorkspaceAccessDeniedMessage, { cause: error })
    }
    throw new Error(missingMessage, { cause: error })
  }
  if (!stats.isDirectory()) throw new Error(missingMessage)
}

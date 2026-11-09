import fs from 'node:fs'

/**
 * 主进程里的 fs 被 Electron 的 asar 层改过：路径里带 `.asar` 的一律当成压缩包里的文件夹回答。
 * Node 的递归删除先 lstat 再决定怎么删，拿到「是文件夹」就对 Contents/Resources/app.asar 调 rmdir，
 * 系统回「不是目录」时它当成已经没了，最后删外层的 Resources 报 ENOTEMPTY。Codex 桌面端（Mac 上的
 * ChatGPT.app）和 Claude Desktop 都是 Electron 应用，删它们的副本次次撞上（2026-11-06 yoyo 的 Mac）。
 * Electron 自带的 original-fs 是没改过的那份；不在 Electron 里（单元测试）时 node:fs 本来就没改过。
 */
function unpatchedFileSystem(): typeof fs {
  return process.versions.electron ? require('original-fs') as typeof fs : fs
}

/**
 * 整个删掉一个目录（不在就算删完了）。跟 fs.promises.rm 一样不跟着链接走：里面的链接只删链接本身。
 * 删别家应用的副本、放过应用的暂存目录都走这里。
 */
export async function removeTree(target: string): Promise<void> {
  await unpatchedFileSystem().promises.rm(target, { recursive: true, force: true })
}

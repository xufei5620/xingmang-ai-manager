import fs from 'node:fs'

/**
 * 读别家 Electron 应用（Claude Desktop、Codex 桌面端）的 app.asar 这个文件本身时用的 fs。
 *
 * 主进程里的 node:fs 被 Electron 的 asar 层改过：路径落在 `*.asar` 上，一律当成压缩包里的根文件夹回答。stat 说它是
 * 文件夹（大小 0，修改时间是编的、整个进程里不变），open 报 `EISDIR: illegal operation on a directory`。替 Claude Desktop
 * 预放 Claude Code 和工作区都要先读它 app.asar 里的清单，打包版里因此一次都没读成（0.2.25 Windows 真机，日志
 * claude-desktop.code-seed.skipped / workspace-seed.skipped，cause 是 EISDIR）；单元测试跑在普通 Node 里，看不出来。
 *
 * Electron 自带的 original-fs 是没改过的那份；不在 Electron 里（单元测试、CI 里的同步脚本）时 node:fs 本来就没改过。
 * 不用 process.noAsar：那是整个进程的开关，开着的那一刻别处读自家 app.asar 里的文件也会失败。
 * 要读压缩包里面的某个文件（比如 Codex 桌面端的 app.asar/package.json）照旧用 node:fs，那正是 asar 层该管的事。
 * 删别家应用的副本另有 remove-tree.ts，同一个道理。
 */
export function asarRawFs(): typeof fs {
  return process.versions.electron ? require('original-fs') as typeof fs : fs
}

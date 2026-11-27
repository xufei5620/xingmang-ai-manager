import fs from 'node:fs'

/**
 * 别家 Electron 应用（Claude Desktop）的 app.asar 本身，要当一个普通文件按字节读。
 *
 * 主进程的 node:fs 被 Electron 的 asar 层改过：路径落在 `.asar` 上一律当成压缩包的根目录回答，
 * stat 回「文件夹、大小 0」，open 直接报 EISDIR。0.2.25 正式包里 Windows 放 Claude Code（#1932）、
 * 放工作区（#2033）因此次次跳过（2026-11-27 yoyo 真机日志 `asar-unreadable` / EISDIR）；单元测试跑在
 * 普通 Node 里，测不出来。Electron 自带的 original-fs 是没改过的那份；不在 Electron 里（单元测试、
 * 存储桶同步作业）时 node:fs 本来就没改过。
 */
function unpatchedFileSystem(): typeof fs {
  return process.versions.electron ? require('original-fs') as typeof fs : fs
}

/** 只读打开那份 app.asar。 */
export function openForeignAsar(asarPath: string): Promise<fs.promises.FileHandle> {
  return unpatchedFileSystem().promises.open(asarPath, 'r')
}

/** 那份 app.asar 真实的大小和修改时间：读出来的清单按它缓存，Claude 升级换了文件才重读。 */
export function statForeignAsar(asarPath: string): Promise<fs.Stats> {
  return unpatchedFileSystem().promises.stat(asarPath)
}

import fs from 'node:fs'
import path from 'node:path'

export interface AppxVolumeLinkFileSystem {
  lstat?: (value: string) => fs.Stats
  readlink?: (value: string) => string
}

export interface AppxVolumeLink {
  /** 包实际所在的盘符（大写，不带冒号）。 */
  drive: string
}

/**
 * Windows 把新应用存到别的盘（设置里「新的应用将保存到」）时，包装在 <盘符>:\WindowsApps\<包全名>，
 * Program Files\WindowsApps 里同名那一项换成系统放的链接，注册信息里的安装位置还写 C 盘那个。
 * 星芒的路径核对不认链接，这种电脑上 Claude Desktop 一律核不过（2026-10-24 yoyo 真机）。
 *
 * 这里只认出这种情况，好把报错换成教客户移回系统盘的话（yoyo 10-24 定：校验不放宽）。
 * 调用方只在核对已经不过之后才问它，认出来也照样拒，所以它不必证明链接可信，读不了就当认不出。
 */
export function inspectAppxVolumeLink(location: string, systemDrive: string, fileSystem: AppxVolumeLinkFileSystem = {}): AppxVolumeLink | null {
  const lstat = fileSystem.lstat ?? ((value: string) => fs.lstatSync(value))
  const readlink = fileSystem.readlink ?? ((value: string) => fs.readlinkSync(value))
  try {
    if (!path.win32.isAbsolute(location) || !lstat(location).isSymbolicLink()) return null
    const target = readlink(location).replace(/^\\\\\?\\(?=[A-Za-z]:\\)/, '')
    const match = /^([A-Za-z]):\\WindowsApps\\([^\\]+)$/i.exec(path.win32.normalize(target).replace(/\\+$/, ''))
    if (!match || match[2].toLowerCase() !== path.win32.basename(location).toLowerCase()) return null
    const drive = match[1].toUpperCase()
    return drive === systemDrive.toUpperCase() ? null : { drive }
  } catch {
    return null
  }
}

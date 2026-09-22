import fs from 'node:fs'
import path from 'node:path'
import { assertNoReparseComponents } from './safe-local-data'

interface DirectoryInfo {
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

export interface ConfigDirectoryProbe {
  lstat?: (target: string) => DirectoryInfo
  assertNoReparse?: (target: string, label: string) => void
}

/**
 * Validate a CLI config folder before handing it to the desktop shell. The
 * folder sits in the user's own writable home, so a junction planted there
 * would otherwise make Explorer open an attacker-chosen target (I8).
 *
 * 刻意不创建目录:「还没有生成」是真实状态,替用户建一个空目录只会让他以为
 * 配置已经写过了。
 */
export function assertOpenableConfigDirectory(
  directory: string,
  probe: ConfigDirectoryProbe = {},
): void {
  const resolved = path.resolve(directory)
  const assertNoReparse = probe.assertNoReparse ?? assertNoReparseComponents
  assertNoReparse(resolved, '工具配置文件夹')
  let info: DirectoryInfo
  try {
    info = (probe.lstat ?? fs.lstatSync)(resolved)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('这个工具的配置文件夹还没有生成。连接当前账号或保存一次配置之后就会出现。')
    }
    throw new Error('工具配置文件夹无法读取')
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('工具配置文件夹必须是普通目录')
}

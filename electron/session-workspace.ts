import fs from 'node:fs/promises'
import path from 'node:path'

interface WorkspaceInfo {
  isDirectory(): boolean
}

export interface SessionWorkspaceProbe {
  stat?: (target: string) => Promise<WorkspaceInfo>
}

/**
 * Validate a session's recorded working folder before handing it to the desktop
 * shell. The path comes from CLI session files, not from the renderer, but those
 * files are plain JSON/SQLite in the user's home: a rewritten `cwd` pointing at
 * an executable would make `shell.openPath` RUN it instead of opening a folder.
 * Only a real directory may reach the shell.
 *
 * 刻意不照搬 config-directory.ts 的 lstat + 「拒绝任何 reparse 组件」：那是给
 * 我们自己写出来的配置目录定的规矩，而这里是用户自己的项目目录，`D:\dev` 本来
 * 就可能是个联接。跟随链接、只认「最终是目录」，与旁边那颗「接着聊」判断目录
 * 存在时（provider-sessions.ts 的 workspaceDirectoryExists）逐字对齐——两颗按钮
 * 挨在一起，一颗能用一颗报错会让用户以为软件坏了。
 */
export async function resolveOpenableSessionWorkspace(
  workspace: string,
  probe: SessionWorkspaceProbe = {},
): Promise<string> {
  const trimmed = workspace.trim()
  if (trimmed === '') throw new Error('这条记录没有记下文件夹，没有可以打开的位置。')
  // 相对路径会被 path.resolve 拼到本程序自己的工作目录上，打开的就不是用户
  // 以为的那个文件夹了；记录里本来也只会有绝对路径。
  if (!path.isAbsolute(trimmed)) throw new Error('这条记录的文件夹位置不完整，打不开。')
  const resolved = path.resolve(trimmed)
  let info: WorkspaceInfo
  try {
    info = await (probe.stat ?? fs.stat)(resolved)
  } catch {
    // 目录被删、被搬走、盘符掉了、权限不足——用户的处境都是「这个文件夹打不开」。
    throw new Error('这条记录的文件夹已经不在了。')
  }
  if (!info.isDirectory()) throw new Error('这条记录的位置不是文件夹，没有打开。')
  return resolved
}

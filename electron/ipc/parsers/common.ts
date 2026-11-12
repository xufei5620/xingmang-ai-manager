// 主窗口业务通道的入参解析（#1070 第 6 步从 ipc.ts 原样搬来，按域分文件，ipc.ts 只管注册）。
// 渲染进程送来的每个参数都当敌意输入（I5）：只认已知字段、限长、拒绝 NUL，出错就抛能直接上屏的中文。
// 别换成 zod / valibot / ajv（AGENTS.md §7）。这个文件是各域共用的几个基础校验。
import path from 'node:path'

export function requiredString(value: unknown, label: string, maximum = 4_096): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || value.includes('\0')) {
    throw new Error(`${label}格式错误`)
  }
  return value.trim()
}

// Windows 的完整路径只有两种：带盘符的（C:\ 或 C:/ 开头）和网络共享的（\\server\share）。
// `\foo` 在 path.win32 眼里也算绝对路径，其实是「当前盘的根下面」，跟 `C:foo` 一样要看主进程当时在哪个盘。
const windowsFullPath = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/

/**
 * 工作目录只收这台电脑认得的完整路径（I5）。相对路径（`.`、`foo`）按主进程自己的当前目录算，
 * workspace-guard 认不出它落在哪儿，「这个文件夹不建议打开」那一问就被跳过了。选择框、会话记录
 * 和记住的目录给的都是完整路径，正常用碰不到这一条。
 */
export function requiredWorkspacePath(value: unknown, platform: NodeJS.Platform): string {
  const workspace = requiredString(value, '工作目录', 32_767)
  const full = platform === 'win32' ? windowsFullPath.test(workspace) : path.posix.isAbsolute(workspace)
  if (!full) throw new Error('工作目录格式错误')
  return workspace
}

export function optionalString(value: unknown, label: string, maximum = 4_096): string | undefined {
  if (value === undefined || value === '') return undefined
  return requiredString(value, label, maximum)
}

export function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error(`${label}格式错误`)
  return value
}

export function stringArray(value: unknown, label: string, maximumItems = 128): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > maximumItems) throw new Error(`${label}格式错误`)
  return value.map((entry) => requiredString(entry, label))
}

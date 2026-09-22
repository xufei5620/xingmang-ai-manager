import fs from 'node:fs'
import path from 'node:path'

// Claude Code 的 statusLine 是「一条命令」：CLI 每隔几百毫秒起一次这个命令，把会话信息
// 从 stdin 递进去，把它打印的内容显示在输入框下面。本软件随包带一个只读 stdin 的小脚本
// （bundled-catalog/cli-status-line/），让用户一眼看到当前模型、目录和上下文占比。
//
// 命令由平台 shell 执行（macOS/Linux 是 sh，Windows 是 cmd.exe，2.1.278 的包里写明了这一点），
// 所以两个路径都要加引号；而引号能挡住空格与括号，挡不住 shell 自己的替换语法。凡是路径里
// 出现引号、$、`、% 或换行，就干脆不写状态行——少一行状态栏是小事，把用户的安装路径交给
// shell 去展开不是。
const UNSAFE_COMMAND_PATH_PATTERN = /["`$%\r\n]/

export const CLAUDE_STATUS_LINE_SCRIPT_NAME = 'xingmang-statusline.cjs'

const CLAUDE_STATUS_LINE_SCRIPT_RELATIVE = [
  'bundled-catalog',
  'cli-status-line',
  CLAUDE_STATUS_LINE_SCRIPT_NAME,
] as const

export interface ClaudeStatusLineSetting {
  type: 'command'
  command: string
}

/**
 * 打包后脚本走 extraResources（asar 外的真实文件，外部 node 才读得到），开发时走仓库目录。
 * 与 project-instructions.ts 同一套找法。
 */
export function resolveClaudeStatusLineScriptPath(
  appPath: string,
  options: { packaged?: boolean; resourcesPath?: string } = {},
): string | null {
  const candidates: string[] = []
  if (options.packaged && options.resourcesPath) {
    candidates.push(path.join(path.resolve(options.resourcesPath), ...CLAUDE_STATUS_LINE_SCRIPT_RELATIVE))
  }
  candidates.push(path.join(path.resolve(appPath), ...CLAUDE_STATUS_LINE_SCRIPT_RELATIVE))
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      // 打包漏拷、路径读不到都只是「这次没有状态行」，不该打断配置写入。
    }
  }
  return null
}

/** 两个绝对路径任何一个不安全或为空就返回 null，调用方据此跳过状态行。 */
export function buildClaudeStatusLineCommand(
  nodeExecutable: string,
  scriptPath: string,
): string | null {
  const node = nodeExecutable.trim()
  const script = scriptPath.trim()
  if (!node || !script) return null
  if (!path.isAbsolute(node) || !path.isAbsolute(script)) return null
  if (UNSAFE_COMMAND_PATH_PATTERN.test(node) || UNSAFE_COMMAND_PATH_PATTERN.test(script)) return null
  return `"${node}" "${script}"`
}

/**
 * 这条 statusLine 是不是本软件写的。认脚本文件名：用户自己配的状态行不会提到它。
 * 认出来才允许改写 command——软件换了安装位置或升级后路径会变，不跟着改就变成一条
 * 指向旧路径的死命令。
 */
export function isManagedClaudeStatusLine(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.type === 'command'
    && typeof record.command === 'string'
    && record.command.includes(CLAUDE_STATUS_LINE_SCRIPT_NAME)
}

export function claudeStatusLineSetting(command: string): ClaudeStatusLineSetting {
  return { type: 'command', command }
}

/**
 * 用户自己设过 statusLine 就整段不动——那是他对终端长什么样的明确表达，往里塞我们的
 * 命令会直接把他的状态行顶掉。只有「没设过」和「设的就是我们这条」两种情况才写。
 */
export function applyClaudeStatusLine(parsed: Record<string, unknown>, command: string): void {
  const existing = parsed.statusLine
  if (existing === undefined) {
    parsed.statusLine = claudeStatusLineSetting(command)
    return
  }
  if (!isManagedClaudeStatusLine(existing)) return
  const managed = existing as Record<string, unknown>
  managed.command = command
}

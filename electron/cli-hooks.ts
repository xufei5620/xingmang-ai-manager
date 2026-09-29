import fs from 'node:fs'
import path from 'node:path'
import { powerShellLiteral } from './windows-elevation'

// 终端里的 Claude Code / Gemini CLI 出错、做完或停下来等人时，以及 Codex 做完一轮时，由它们自己的钩子起一次
// 随包脚本（bundled-catalog/cli-hooks/），脚本往星芒数据目录里丢一个小文件，主进程
// （cli-hook-events.ts）读到后弹系统通知。这个文件只管「往 CLI 配置里写哪几行」。
//
// 两家执行钩子的方式不同，决定了命令怎么写：
//   * Claude Code 支持 exec 形式（command + args），直接起进程不经过任何 shell——路径里
//     有空格、中文、引号都不用转义。2.1.150 起就有这个字段（本仓已核 2.1.150/2.1.277/2.1.282）。
//   * Gemini CLI 只收一整条 shell 命令：Windows 上交给 PowerShell，其余系统交给 bash。
//     所以要按平台逐段加引号，并且在执行前它还会把 $GEMINI_CWD 一类的字样替换成别的路径。
//   * Codex 的 notify 是一个参数数组，同样不经过 shell，它把一段 JSON 追加成最后一个参数。
// 路径里出现 `"`、`$`、`` ` ``、`%` 或换行就干脆不写钩子，与状态行同一条规矩：少几条
// 通知是小事，把用户的安装路径交给 shell 展开不是。
const UNSAFE_HOOK_PATH_PATTERN = /["`$%\r\n\0]/

export const CLI_HOOK_SCRIPT_NAME = 'xingmang-hook.cjs'
export const CLI_HOOK_EVENTS_DIRECTORY_NAME = 'cli-events'

const CLI_HOOK_SCRIPT_RELATIVE = ['bundled-catalog', 'cli-hooks', CLI_HOOK_SCRIPT_NAME] as const

export type CliHookTool = 'claude' | 'gemini' | 'codex'

export interface CliHookInvocation {
  nodeExecutable: string
  scriptPath: string
  eventsDirectory: string
  /** 决定 Gemini 那条 shell 命令按 PowerShell 还是 bash 的规矩加引号。 */
  platform: NodeJS.Platform
}

// 选这几类事件的原因见 bundled-catalog/cli-hooks/xingmang-hook.cjs：开始用来算一轮跑了
// 多久，结束/出错/等人才可能弹通知。
const claudeHookEvents = ['UserPromptSubmit', 'Stop', 'StopFailure', 'Notification'] as const
const geminiHookEvents = ['BeforeAgent', 'AfterAgent', 'Notification'] as const

/** 打包后走 extraResources（外部 node 读不了 asar），开发时走仓库目录；与状态行同一套找法。 */
export function resolveCliHookScriptPath(
  appPath: string,
  options: { packaged?: boolean; resourcesPath?: string } = {},
): string | null {
  const candidates: string[] = []
  if (options.packaged && options.resourcesPath) {
    candidates.push(path.join(path.resolve(options.resourcesPath), ...CLI_HOOK_SCRIPT_RELATIVE))
  }
  candidates.push(path.join(path.resolve(appPath), ...CLI_HOOK_SCRIPT_RELATIVE))
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      // 打包漏拷、路径读不到都只是「这次不写钩子」，不该打断配置写入。
    }
  }
  return null
}

export function cliHookEventsDirectory(managerDataDirectory: string): string {
  return path.join(managerDataDirectory, CLI_HOOK_EVENTS_DIRECTORY_NAME)
}

/** 三个路径任何一个为空、不是绝对路径或带 shell 元字符就返回 null，调用方据此不写钩子。 */
export function buildCliHookInvocation(
  nodeExecutable: string,
  scriptPath: string,
  eventsDirectory: string,
  platform: NodeJS.Platform = process.platform,
): CliHookInvocation | null {
  const values = [nodeExecutable.trim(), scriptPath.trim(), eventsDirectory.trim()]
  if (values.some((value) => !value || !path.isAbsolute(value) || UNSAFE_HOOK_PATH_PATTERN.test(value))) return null
  const [node, script, events] = values as [string, string, string]
  return { nodeExecutable: node, scriptPath: script, eventsDirectory: events, platform }
}

function posixShellLiteral(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function geminiCliHookCommand(invocation: CliHookInvocation): string {
  const { nodeExecutable, scriptPath, eventsDirectory } = invocation
  if (invocation.platform === 'win32') {
    // PowerShell 里以引号开头的一段是字符串表达式，不是命令，必须用 & 调用。
    return `& ${powerShellLiteral(nodeExecutable)} ${powerShellLiteral(scriptPath)} gemini ${powerShellLiteral(eventsDirectory)}`
  }
  return `${posixShellLiteral(nodeExecutable)} ${posixShellLiteral(scriptPath)} gemini ${posixShellLiteral(eventsDirectory)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** 这一条钩子是不是本软件写的：认脚本文件名，用户自己写的钩子不会提到它。 */
export function isManagedCliHook(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (typeof value.command === 'string' && value.command.includes(CLI_HOOK_SCRIPT_NAME)) return true
  return Array.isArray(value.args) && value.args.some((arg) => typeof arg === 'string' && arg.includes(CLI_HOOK_SCRIPT_NAME))
}

/**
 * 从某个事件的钩子组里摘掉本软件那几条，其余原样保留；摘空的组整组去掉。
 * 组的形状不认识（不是对象、hooks 不是数组）就原样留着——那是用户的东西。
 */
function withoutManagedHooks(groups: unknown[]): unknown[] {
  const kept: unknown[] = []
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.hooks)) {
      kept.push(group)
      continue
    }
    const hooks = group.hooks.filter((hook) => !isManagedCliHook(hook))
    if (hooks.length === group.hooks.length) kept.push(group)
    else if (hooks.length > 0) kept.push({ ...group, hooks })
  }
  return kept
}

/**
 * 把本软件的钩子并进 hooks 字段：先摘掉旧的（软件换了安装位置或升级后路径会变），再在
 * 每个事件末尾追加一组。用户自己写的钩子一条不动，排在我们前面照常执行。
 * hooks 字段或某个事件的值格式不认识就不碰，免得把用户写坏的配置「修」成别的样子。
 */
function mergeManagedHooks(
  settings: Record<string, unknown>,
  events: readonly string[],
  group: () => Record<string, unknown>,
): void {
  if (settings.hooks === undefined) settings.hooks = {}
  const hooks = settings.hooks
  if (!isRecord(hooks)) return
  for (const event of events) {
    const current = hooks[event]
    if (current !== undefined && !Array.isArray(current)) continue
    hooks[event] = [...withoutManagedHooks(current ?? []), group()]
  }
}

function removeManagedHooks(settings: Record<string, unknown>): void {
  const hooks = settings.hooks
  if (!isRecord(hooks)) return
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue
    const kept = withoutManagedHooks(groups)
    if (kept.length === groups.length) continue
    if (kept.length > 0) hooks[event] = kept
    else delete hooks[event]
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks
}

export function applyClaudeCliHooks(settings: Record<string, unknown>, invocation: CliHookInvocation): void {
  mergeManagedHooks(settings, claudeHookEvents, () => ({
    hooks: [{
      type: 'command',
      command: invocation.nodeExecutable,
      args: [invocation.scriptPath, 'claude', invocation.eventsDirectory],
      // 放到后台跑：一次 node 启动在 Windows 上要一两百毫秒，不该让每一轮都等它。
      async: true,
      timeout: 10,
    }],
  }))
}

export function removeClaudeCliHooks(settings: Record<string, unknown>): void {
  removeManagedHooks(settings)
}

export function applyGeminiCliHooks(settings: Record<string, unknown>, invocation: CliHookInvocation): void {
  const command = geminiCliHookCommand(invocation)
  mergeManagedHooks(settings, geminiHookEvents, () => ({
    hooks: [{
      name: 'xingmang-notify',
      type: 'command',
      command,
      // Gemini 按毫秒算。
      timeout: 10000,
    }],
  }))
}

export function removeGeminiCliHooks(settings: Record<string, unknown>): void {
  removeManagedHooks(settings)
}

function isManagedCodexNotify(value: unknown): boolean {
  return Array.isArray(value) && value.some((arg) => typeof arg === 'string' && arg.includes(CLI_HOOK_SCRIPT_NAME))
}

/**
 * Codex 的 notify 只能有一条。用户自己设过（桌面提醒脚本之类）就不动，这台电脑上 Codex
 * 做完不提醒就是了；是我们写的就换成这次的路径（软件换了安装位置或升级后路径会变）。
 */
export function applyCodexCliNotify(config: Record<string, unknown>, invocation: CliHookInvocation): void {
  if (config.notify !== undefined && !isManagedCodexNotify(config.notify)) return
  config.notify = [invocation.nodeExecutable, invocation.scriptPath, 'codex', invocation.eventsDirectory]
}

export function removeCodexCliNotify(config: Record<string, unknown>): void {
  if (isManagedCodexNotify(config.notify)) delete config.notify
}

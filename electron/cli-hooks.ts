import fs from 'node:fs'
import path from 'node:path'
import { powerShellLiteral } from './windows-elevation'

// 终端里的 Claude Code / Gemini CLI / Grok 开始、出错、做完、停下来等人或退出时，以及 Codex 做完一轮时，由它们自己的钩子起一次
// 随包脚本（bundled-catalog/cli-hooks/），脚本往星芒数据目录里丢一个小文件，主进程
// （cli-hook-events.ts）读到后弹系统通知、挡住或放开睡眠（cli-keep-awake.ts）。这个文件只管
// 「往 CLI 配置里写哪几行」。
//
// 几家执行钩子的方式不同，决定了命令怎么写：
//   * Claude Code 支持 exec 形式（command + args），直接起进程不经过任何 shell——路径里
//     有空格、中文、引号都不用转义。2.1.150 起就有这个字段（本仓已核 2.1.150/2.1.277/2.1.282）。
//   * Gemini CLI 只收一整条 shell 命令：Windows 上交给 PowerShell，其余系统交给 bash。
//     所以要按平台逐段加引号，并且在执行前它还会把 $GEMINI_CWD 一类的字样替换成别的路径。
//   * Codex 的 notify 是一个参数数组，同样不经过 shell，它把一段 JSON 追加成最后一个参数。
//   * Grok 只收一整条 shell 命令，写在它自己的 config.toml 里（见 applyGrokCliHooks）。
// 路径里出现 `"`、`$`、`` ` ``、`%` 或换行就干脆不写钩子，与状态行同一条规矩：少几条
// 通知是小事，把用户的安装路径交给 shell 展开不是。
const UNSAFE_HOOK_PATH_PATTERN = /["`$%\r\n\0]/

export const CLI_HOOK_SCRIPT_NAME = 'xingmang-hook.cjs'
export const CLI_HOOK_EVENTS_DIRECTORY_NAME = 'cli-events'

const CLI_HOOK_SCRIPT_RELATIVE = ['bundled-catalog', 'cli-hooks', CLI_HOOK_SCRIPT_NAME] as const

export type CliHookTool = 'claude' | 'gemini' | 'codex' | 'grok'

export interface CliHookInvocation {
  nodeExecutable: string
  scriptPath: string
  eventsDirectory: string
  /** 决定 Gemini 那条 shell 命令按 PowerShell 还是 bash 的规矩加引号。 */
  platform: NodeJS.Platform
}

// 选这几类事件的原因见 bundled-catalog/cli-hooks/xingmang-hook.cjs：开始用来算一轮跑了
// 多久、挡住睡眠，结束/出错/等人才可能弹通知，退出（SessionEnd）用来放开睡眠。
// 刻意不挂每次调用工具都触发的 PostToolUse 一类：每调一次工具就多起一个进程，Claude Code
// 还会因为有这类钩子而不再把工具调用放到后台跑。
const claudeHookEvents = ['UserPromptSubmit', 'Stop', 'StopFailure', 'Notification', 'SessionEnd'] as const
const geminiHookEvents = ['BeforeAgent', 'AfterAgent', 'Notification', 'SessionEnd'] as const
// Grok 1.0.41 被打断时报 StopCancelled 而不是 Stop。
const grokHookEvents = ['UserPromptSubmit', 'Stop', 'StopFailure', 'StopCancelled', 'Notification', 'SessionEnd'] as const

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

/** Grok 的钩子命令交给 sh 跑：Linux 上 1.0.41 实测路径带空格照样能起；macOS 推测同一套。 */
export function grokCliHookCommand(invocation: CliHookInvocation): string {
  const { nodeExecutable, scriptPath, eventsDirectory } = invocation
  return `${posixShellLiteral(nodeExecutable)} ${posixShellLiteral(scriptPath)} grok ${posixShellLiteral(eventsDirectory)}`
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

/**
 * Grok 默认会把 ~/.claude/settings.json 里的钩子也拿来跑（Claude 兼容），可它不认 Claude 的
 * args 字段，只跑 command——于是我们给 Claude Code 写的钩子在 Grok 里变成光秃秃起一个 node、
 * 把事件 JSON 当脚本喂给它，每一轮都在终端里报一条钩子失败（1.0.41 对本地假接口实测）。
 * 所以接当前账号时关掉 Grok 的 Claude 钩子兼容；用户自己在 [compat.claude] 里设过 hooks 就不动。
 *
 * Grok 自己的钩子只在非 Windows 上写：Windows 版程序里能看到它会在 pwsh / Git Bash /
 * Windows PowerShell 之间挑 shell，同一条命令没法三种都对，真机核过之前宁可不写——少一个
 * 防睡不会出错，写错了却每一轮都报红。
 */
export function applyGrokCliHooks(config: Record<string, unknown>, invocation: CliHookInvocation): void {
  if (config.compat === undefined) config.compat = {}
  const compat = config.compat
  if (isRecord(compat)) {
    if (compat.claude === undefined) compat.claude = {}
    const claude = compat.claude
    if (isRecord(claude) && claude.hooks === undefined) claude.hooks = false
  }
  if (invocation.platform === 'win32') return
  const command = grokCliHookCommand(invocation)
  mergeManagedHooks(config, grokHookEvents, () => ({
    // Grok 的 UserPromptSubmit 和 Stop 是同步的，一次 node 启动的工夫；给个上限免得卡住它。
    hooks: [{ type: 'command', command, timeout: 10 }],
  }))
}

export function removeGrokCliHooks(config: Record<string, unknown>): void {
  removeManagedHooks(config)
}

// ---------------------------------------------------------------------------
// 写下去的路径还活着吗
//
// 钩子、状态行、Codex 的 notify 里写的都是绝对路径，只在保存配置那一刻算一次。卸载后
// 换个文件夹重装、Mac 上把 app 挪了位置、换装了 Node.js，这些路径就指向不存在的文件，
// 工具每一轮都在终端里报一条红字。下面这几个函数只负责把我们那几条命令拆回「哪个程序、
// 哪个脚本」，判断和重写在 config-files.ts 与 system-service.ts。
// ---------------------------------------------------------------------------

/** 本软件写进配置的一条命令指向的程序和脚本。拆不开时两项都是空串，按「坏了」算。 */
export interface ManagedCliHookTarget {
  nodeExecutable: string
  scriptPath: string
}

/**
 * 把本软件自己写出来的命令拆回一段段参数。只认这里写得出来的几种引号：POSIX 的 '…'
 * （内部单引号写成 '\''）、PowerShell 的 '…'（内部写成 ''，开头带 & 调用符）、状态行的
 * "…"（不安全字符根本不会写进去，所以不处理转义）。引号没闭合返回 null。
 */
export function splitManagedCommand(command: string): string[] | null {
  let text = command.trim()
  if (text.startsWith('& ')) text = text.slice(2)
  const words: string[] = []
  let current = ''
  let inWord = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === "'" || char === '"') {
      inWord = true
      let closed = false
      for (index += 1; index < text.length; index += 1) {
        if (text[index] !== char) {
          current += text[index]
          continue
        }
        if (char === "'" && text[index + 1] === "'") {
          current += "'"
          index += 1
          continue
        }
        closed = true
        break
      }
      if (!closed) return null
    } else if (char === '\\') {
      if (index + 1 >= text.length) return null
      index += 1
      current += text[index]
      inWord = true
    } else if (/\s/.test(char)) {
      if (inWord) words.push(current)
      current = ''
      inWord = false
    } else {
      current += char
      inWord = true
    }
  }
  if (inWord) words.push(current)
  return words
}

function targetFromWords(words: readonly unknown[] | null): ManagedCliHookTarget {
  const [node, script] = words ?? []
  return {
    nodeExecutable: typeof node === 'string' ? node : '',
    scriptPath: typeof script === 'string' ? script : '',
  }
}

function hookTarget(hook: Record<string, unknown>): ManagedCliHookTarget {
  // Claude Code 的 exec 形式：command 是程序，args[0] 是脚本。
  if (Array.isArray(hook.args)) return targetFromWords([hook.command, hook.args[0]])
  return targetFromWords(typeof hook.command === 'string' ? splitManagedCommand(hook.command) : null)
}

/** 某家配置里本软件那几条钩子（Codex 是 notify）各自指向哪里；用户自己写的不在其内。 */
export function managedCliHookTargets(tool: CliHookTool, config: Record<string, unknown>): ManagedCliHookTarget[] {
  if (tool === 'codex') return isManagedCodexNotify(config.notify) ? [targetFromWords(config.notify as unknown[])] : []
  const hooks = config.hooks
  if (!isRecord(hooks)) return []
  const targets: ManagedCliHookTarget[] = []
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) continue
      for (const hook of group.hooks) {
        if (isManagedCliHook(hook)) targets.push(hookTarget(hook as Record<string, unknown>))
      }
    }
  }
  return targets
}

function comparablePath(value: string, platform: NodeJS.Platform): string {
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  const resolved = pathApi.normalize(value)
  return platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * 这几条命令里有没有指向旧位置的：程序或脚本不在了，或者脚本不是这次安装带的那一份
 * （换了文件夹重装、旧目录还没删干净时，旧脚本还在，但下次卸载就没了，也按旧的算）。
 * currentScripts 是这次安装带的脚本，缺省或找不到时只看文件在不在。
 */
export function cliHookTargetsStale(
  targets: readonly ManagedCliHookTarget[],
  currentScripts: readonly (string | null | undefined)[] = [],
  options: { exists?: (file: string) => boolean; platform?: NodeJS.Platform } = {},
): boolean {
  const platform = options.platform ?? process.platform
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  const exists = options.exists ?? ((file: string) => {
    try {
      return fs.existsSync(file)
    } catch {
      return false
    }
  })
  const current = currentScripts.filter((script): script is string => Boolean(script))
  return targets.some(({ nodeExecutable, scriptPath }) => {
    if (!nodeExecutable || !scriptPath || !pathApi.isAbsolute(nodeExecutable) || !pathApi.isAbsolute(scriptPath)) return true
    if (!exists(nodeExecutable) || !exists(scriptPath)) return true
    const sameName = current.find((script) => pathApi.basename(script).toLowerCase() === pathApi.basename(scriptPath).toLowerCase())
    return sameName !== undefined && comparablePath(sameName, platform) !== comparablePath(scriptPath, platform)
  })
}

import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  isUserWritableResolvedPathSync,
  trustedCommandEnvironment,
  type CommandSpec,
} from './command-runner'
import { resolveWindowsMachinePaths, type WindowsMachinePaths } from './windows-machine-paths'

const execFileAsync = promisify(execFile)

export interface WindowsCliLaunchRequest {
  executable: string
  argv?: readonly string[]
  workspace: string
  title: string
  env?: NodeJS.ProcessEnv
}

export interface WindowsPowerShellLaunchPlan {
  executable: string
  argv: string[]
  cwd: string
  windowsHide: true
}

export interface WindowsPowerShellResolutionOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  isFile?: (candidate: string) => boolean
  isTrustedPath?: (candidate: string, env: NodeJS.ProcessEnv) => boolean
  machinePaths?: WindowsMachinePaths
}

export interface TrustedElevatedCliCommandOptions {
  env?: NodeJS.ProcessEnv
  isUserWritableResolvedPath?: (candidate: string, env: NodeJS.ProcessEnv) => boolean
  machinePaths?: WindowsMachinePaths
}

export type WindowsCliExecutionMode = 'trusted-only' | 'same-user'

export interface ResolveWindowsCliExecutionModeOptions {
  isPackaged: boolean
  platform?: NodeJS.Platform
  probeAdministrator?: () => Promise<boolean>
}

export interface WindowsAdministratorProbeOptions {
  env?: NodeJS.ProcessEnv
  machinePaths?: WindowsMachinePaths
}

/** Resolve Windows PowerShell from the protected system directory. Never let
 * an elevated launch depend on the caller's (user-modifiable) PATH. */
export function windowsPowerShellExecutable(
  _env: NodeJS.ProcessEnv = process.env,
  machinePathsInput?: WindowsMachinePaths,
): string {
  if (process.platform !== 'win32') return 'powershell.exe'
  const machinePaths = machinePathsInput ?? resolveWindowsMachinePaths()
  return path.win32.join(machinePaths.system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

export function windowsPowerShellCandidates(
  _env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  machinePathsInput?: WindowsMachinePaths,
): string[] {
  if (platform !== 'win32') return []
  const machinePaths = machinePathsInput ?? resolveWindowsMachinePaths()
  const candidates = [
    path.win32.join(machinePaths.system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ]
  const programFilesRoots = [machinePaths.programFiles, machinePaths.programFilesX86]
    .filter((value): value is string => Boolean(value))
  for (const root of programFilesRoots) {
    const candidate = path.win32.join(root, 'PowerShell', '7', 'pwsh.exe')
    if (!candidates.some((value) => value.toLowerCase() === candidate.toLowerCase())) {
      candidates.push(candidate)
    }
  }
  return candidates
}

function regularFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile()
  } catch {
    return false
  }
}

/** Resolve only fixed, machine-level PowerShell locations. PATH is never read. */
export function resolveWindowsPowerShellExecutable(
  options: WindowsPowerShellResolutionOptions = {},
): string {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') throw new Error('PowerShell CLI 启动仅支持 Windows')
  const env = options.env ?? process.env
  const machinePaths = options.machinePaths ?? resolveWindowsMachinePaths()
  const isFile = options.isFile ?? regularFile
  const isTrustedPath = options.isTrustedPath
    ?? ((candidate, candidateEnv) => !isUserWritableResolvedPathSync(candidate, candidateEnv, machinePaths))
  const executable = windowsPowerShellCandidates(env, platform, machinePaths)
    .find((candidate) => isFile(candidate) && isTrustedPath(candidate, env))
  if (executable) return executable
  throw new Error(
    '未找到可用的系统 PowerShell；请启用 Windows PowerShell，或将 64 位 PowerShell 7 安装到 Program Files\\PowerShell\\7',
  )
}

/**
 * Detects the current Windows token without consulting PATH or a user-owned
 * executable. An invalid probe result is an error so callers can fail closed.
 */
export async function inspectCurrentWindowsProcessAdministrator(
  options: WindowsAdministratorProbeOptions = {},
): Promise<boolean> {
  if (process.platform !== 'win32') return false
  const env = options.env ?? process.env
  const machinePaths = options.machinePaths ?? resolveWindowsMachinePaths()
  const { stdout } = await execFileAsync(
    resolveWindowsPowerShellExecutable({ env, machinePaths }),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$identity=[Security.Principal.WindowsIdentity]::GetCurrent();$principal=[Security.Principal.WindowsPrincipal]::new($identity);$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    ],
    {
      env: trustedCommandEnvironment(env, machinePaths),
      windowsHide: true,
      timeout: 8_000,
      maxBuffer: 64 * 1024,
    },
  )
  const value = stdout.trim().toLowerCase()
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error('无法确认当前 Windows 进程是否具有管理员权限')
}

/** Packaged and development builds normally run as the current user. If a user
 * explicitly starts the app as administrator, retain the restrictive boundary
 * so user-writable commands are never inherited by the elevated process. */
export async function resolveWindowsCliExecutionMode(
  options: ResolveWindowsCliExecutionModeOptions,
): Promise<WindowsCliExecutionMode> {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return 'same-user'
  try {
    const administrator = await (options.probeAdministrator
      ?? (() => inspectCurrentWindowsProcessAdministrator()))()
    return administrator ? 'trusted-only' : 'same-user'
  } catch {
    return 'trusted-only'
  }
}

function requireWindowsLaunchValue(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label}不能为空`)
  if (value.includes('\0')) throw new Error(`${label}包含无效字符`)
  return value
}

export function powerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

export function encodeWindowsPowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

export function decodeWindowsPowerShellCommand(encodedCommand: string): string {
  return Buffer.from(encodedCommand, 'base64').toString('utf16le')
}

export function parseStartedWindowsProcessId(output: string): number | null {
  const line = output.split(/\r?\n/).map((entry) => entry.trim()).find(Boolean)
  if (!line || !/^\d{1,10}$/.test(line)) return null
  const processId = Number(line)
  return Number.isSafeInteger(processId) && processId > 0 ? processId : null
}

export function assertTrustedElevatedCliCommand(
  command: Pick<CommandSpec, 'executable' | 'argv'>,
  toolName: string,
  options: TrustedElevatedCliCommandOptions = {},
): void {
  const env = options.env ?? process.env
  const isUserWritableResolvedPath = options.isUserWritableResolvedPath
    ?? ((candidate, candidateEnv) => (
      isUserWritableResolvedPathSync(candidate, candidateEnv, options.machinePaths)
    ))
  const executable = requireWindowsLaunchValue(command.executable, 'CLI 路径')
  if (!path.win32.isAbsolute(executable)) {
    throw new Error(`${toolName}的运行时不是绝对路径，无法安全地以管理员权限执行`)
  }
  const targets = [
    { value: executable, label: '运行时' },
    ...command.argv
      .filter((argument) => path.win32.isAbsolute(argument))
      .map((value) => ({ value, label: 'CLI 脚本或绝对路径参数' })),
  ]
  const unsafe = targets.find((target) => isUserWritableResolvedPath(target.value, env))
  if (unsafe) {
    throw new Error(
      `${toolName}使用的${unsafe.label}位于用户可写目录、链接目标不可信或已失效，无法安全地以管理员权限执行；请通过本工具重新安装该 CLI（${unsafe.value}）`,
    )
  }
}

export function buildCliLaunchPlan(
  request: WindowsCliLaunchRequest,
  resolvedPowerShellExecutable = windowsPowerShellExecutable(),
): WindowsPowerShellLaunchPlan {
  const cliExecutable = requireWindowsLaunchValue(request.executable, 'CLI 路径')
  const cliArguments = (request.argv ?? []).map((argument) => requireWindowsLaunchValue(argument, 'CLI 参数'))
  const workspace = requireWindowsLaunchValue(request.workspace, '工作目录')
  const title = requireWindowsLaunchValue(request.title, '窗口标题')
  const powershellExecutable = requireWindowsLaunchValue(resolvedPowerShellExecutable, '系统 PowerShell 路径')
  if (!path.win32.isAbsolute(powershellExecutable)) {
    throw new Error('系统 PowerShell 路径必须是绝对路径')
  }

  const terminalScript = [
    `$Host.UI.RawUI.WindowTitle = ${powerShellLiteral(title)}`,
    `$env:TERM = 'xterm-256color'`,
    `$env:COLORTERM = 'truecolor'`,
    `$env:FORCE_COLOR = '3'`,
    `$env:CLICOLOR = '1'`,
    `$env:CLICOLOR_FORCE = '1'`,
    'Remove-Item Env:NO_COLOR -ErrorAction SilentlyContinue',
    'Remove-Item Env:NODE_DISABLE_COLORS -ErrorAction SilentlyContinue',
    `Set-Location -LiteralPath ${powerShellLiteral(workspace)}`,
    `& ${powerShellLiteral(cliExecutable)}${cliArguments.map((argument) => ` ${powerShellLiteral(argument)}`).join('')}`,
  ].join('; ')
  const terminalEncodedCommand = encodeWindowsPowerShellCommand(terminalScript)
  const terminalArguments = [
    '-NoLogo',
    '-NoProfile',
    '-NoExit',
    '-EncodedCommand',
    terminalEncodedCommand,
  ]
  const brokerScript = [
    '$ErrorActionPreference = "Stop"',
    `$process = Start-Process -FilePath ${powerShellLiteral(powershellExecutable)} -ArgumentList @(${terminalArguments.map(powerShellLiteral).join(', ')}) -WorkingDirectory ${powerShellLiteral(workspace)} -WindowStyle Normal -PassThru`,
    '[Console]::Out.WriteLine($process.Id)',
  ].join('; ')

  return {
    executable: powershellExecutable,
    argv: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      encodeWindowsPowerShellCommand(brokerScript),
    ],
    cwd: workspace,
    windowsHide: true,
  }
}

function compactErrorDetail(value: string): string {
  return value
    .replace(/-EncodedCommand\s+\S+/gi, '-EncodedCommand [REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400)
}

export function describeWindowsCliLaunchError(error: unknown): string {
  const candidate = error as NodeJS.ErrnoException & { stderr?: unknown; stdout?: unknown; message?: unknown }
  const detail = compactErrorDetail([
    typeof candidate?.stderr === 'string' ? candidate.stderr : '',
    typeof candidate?.message === 'string' ? candidate.message : String(error ?? ''),
  ].filter(Boolean).join(' '))
  const code = typeof candidate?.code === 'string' ? candidate.code.toUpperCase() : ''
  if (code === 'ENOENT' || /cannot find|找不到.*文件|系统找不到/i.test(detail)) {
    return '系统 PowerShell 启动文件不存在或已被移除，请修复 Windows PowerShell 或安装 PowerShell 7'
  }
  if (
    code === 'EACCES'
    || code === 'EPERM'
    || /access (?:is )?denied|permission denied|拒绝访问|无权访问/i.test(detail)
  ) {
    return 'Windows 拒绝访问 PowerShell 或工作目录，请检查目录权限后重试'
  }
  if (/directory (?:name )?is invalid|cannot find.*path|找不到.*路径|目录.*(?:无效|不存在)/i.test(detail)) {
    return '工作目录已失效或无法访问，请重新选择工作目录'
  }
  return detail
    ? `Windows 无法启动 PowerShell：${detail}`
    : 'Windows 无法启动 PowerShell，请查看反馈与诊断日志'
}

function assertAccessibleWorkspace(workspace: string): void {
  try {
    if (!fs.statSync(workspace).isDirectory()) throw new Error('not-directory')
    fs.accessSync(workspace, fs.constants.R_OK)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'EPERM') {
      throw new Error('工作目录无法访问，请检查目录权限后重试')
    }
    throw new Error('工作目录不存在或已失效，请重新选择')
  }
}

export interface UnelevatedCommandWindowRequest {
  /** 固定拼装的命令行，禁止直接拼入渲染进程传来的字符串。 */
  commandLine: string
  title: string
  env?: NodeJS.ProcessEnv
  machinePaths?: WindowsMachinePaths
}

/** 从提权进程以登录用户身份打开一个命令窗口。explorer.exe 始终以 shell 用户的
 * 令牌运行，它拉起的进程因此不会继承管理员令牌——这是不引入原生模块就能降权的
 * 常规做法。用于执行位于用户可写目录、不应以管理员身份运行的卸载脚本。
 *
 * 批处理内容一律使用 ASCII：cmd.exe 按当前代码页逐行解析 .cmd，写入 UTF-8 中文
 * 会乱码，而 chcp 只对其后的输出生效、管不到解析本身。 */
export async function launchUnelevatedCommandWindow(
  request: UnelevatedCommandWindowRequest,
): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('降权命令窗口仅支持 Windows')
  }
  if (!/^[\x20-\x7E]+$/.test(request.commandLine)) {
    throw new Error('降权命令包含非 ASCII 字符，已拒绝执行')
  }
  const machinePaths = request.machinePaths ?? resolveWindowsMachinePaths()
  const explorer = path.win32.join(machinePaths.systemRoot, 'explorer.exe')
  if (!fs.existsSync(explorer)) throw new Error('未找到 Windows 资源管理器，无法降权执行')

  const script = [
    '@echo off',
    `title ${request.title}`,
    `echo Running: ${request.commandLine}`,
    'echo.',
    `call ${request.commandLine}`,
    'echo.',
    'if errorlevel 1 (echo FAILED with code %errorlevel%) else (echo Completed successfully.)',
    'echo.',
    'echo You can close this window and refresh the app.',
    'pause',
    'del "%~f0"',
    '',
  ].join('\r\n')

  const scriptPath = path.join(os.tmpdir(), `xingmang-uninstall-${randomUUID()}.cmd`)
  await fs.promises.writeFile(scriptPath, script, { encoding: 'ascii', flag: 'wx', mode: 0o600 })
  const child = spawn(explorer, [scriptPath], {
    detached: true,
    stdio: 'ignore',
    env: request.env ?? process.env,
    windowsHide: false,
  })
  child.once('error', () => {
    fs.promises.rm(scriptPath, { force: true }).catch(() => undefined)
  })
  child.unref()
}

export async function launchCliPowerShell(
  request: WindowsCliLaunchRequest,
): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('PowerShell CLI 启动仅支持 Windows')
  }
  assertAccessibleWorkspace(request.workspace)
  const powershellExecutable = resolveWindowsPowerShellExecutable()
  const plan = buildCliLaunchPlan(request, powershellExecutable)
  try {
    const { stdout } = await execFileAsync(plan.executable, plan.argv, {
      cwd: plan.cwd,
      env: request.env ?? process.env,
      windowsHide: plan.windowsHide,
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      encoding: 'utf8',
    })
    if (!parseStartedWindowsProcessId(stdout)) {
      throw new Error('PowerShell 启动代理未返回有效的终端进程 ID')
    }
  } catch (error) {
    throw new Error(describeWindowsCliLaunchError(error))
  }
}

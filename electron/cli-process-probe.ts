/**
 * Updating a managed CLI replaces the whole npm prefix directory. On Windows a
 * running CLI keeps its own executable mapped, so the replacement fails with a
 * sharing violation and the user is told the install was "blocked by antivirus"
 * — the wrong direction entirely. Detecting the CLI's own processes is what
 * lets the failure say「先关掉它的窗口」instead.
 *
 * The matching rule is deliberately narrow: a process counts only when its
 * image, or its command line, points inside the package directory of this one
 * CLI. Matching on a process name would drag in every `node` on the machine,
 * and the user's own second copy of `claude` is not ours to talk about.
 */
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { trustedCommandEnvironment } from './command-runner'
import { resolveWindowsPowerShellExecutable } from './windows-elevation'

const execFileAsync = promisify(execFile)

/** One process this CLI's own install directory accounts for. */
export interface CliProcessMatch {
  processId: number
  name: string
  executablePath: string
}

export interface CliProcessProbe {
  status: 'checked' | 'unsupported' | 'unavailable'
  processes: CliProcessMatch[]
  detail?: string
}

export const cliProcessRootEnvironmentVariable = 'XINGMANG_CLI_PROCESS_ROOT'

/**
 * The probed directory is handed over through the environment rather than
 * spliced into the script: a path is attacker-influenced data (the user picks
 * where npm lives) and PowerShell string literals have their own escaping
 * rules. `.StartsWith`/`.IndexOf` are ordinal .NET calls, so no part of the
 * path is ever parsed as a pattern either (I1).
 */
export function buildWindowsCliProcessProbeScript(): string {
  return [
    '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '$ErrorActionPreference = "SilentlyContinue"',
    `$root = [string]$env:${cliProcessRootEnvironmentVariable}`,
    "if (-not $root) { '[]'; exit 0 }",
    String.raw`$items = @(Get-CimInstance Win32_Process | ForEach-Object {
      $image = [string]$_.ExecutablePath
      $commandLine = [string]$_.CommandLine
      # A node-hosted CLI runs as node.exe with the entry script on its command
      # line, while a native one runs as its own binary. Accept either, but only
      # when the managed package directory itself is what shows up.
      $matched = $false
      if ($image -and $image.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) { $matched = $true }
      if (-not $matched -and $commandLine -and $commandLine.IndexOf($root, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { $matched = $true }
      if ($matched) {
        [pscustomobject]@{ ProcessId = $_.ProcessId; Name = [string]$_.Name; ExecutablePath = $image }
      }
    })`,
    '$items | ConvertTo-Json -Compress',
  ].join('\n')
}

export function parseWindowsCliProcessProbeOutput(output: string): CliProcessMatch[] {
  const trimmed = output.trim().replace(/^﻿/, '')
  if (!trimmed) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return []
  }
  const values = Array.isArray(parsed) ? parsed : [parsed]
  const matches: CliProcessMatch[] = []
  for (const value of values) {
    if (!value || typeof value !== 'object') continue
    const record = value as Record<string, unknown>
    const processId = record.ProcessId
    const name = record.Name
    const executablePath = record.ExecutablePath
    if (typeof processId !== 'number' || !Number.isInteger(processId) || processId <= 0) continue
    matches.push({
      processId,
      name: typeof name === 'string' ? name : '',
      executablePath: typeof executablePath === 'string' ? executablePath : '',
    })
  }
  return matches
}

/**
 * `ps -xo` without `-a` lists only the current user's processes. That is both
 * the correct scope (another account's CLI is not ours to ask about) and the
 * one that keeps other people's command lines — which can carry their own
 * secrets — out of this process entirely.
 */
export function buildDarwinCliProcessProbeArgv(): { executable: string; argv: string[] } {
  return { executable: '/bin/ps', argv: ['-xo', 'pid=,args='] }
}

export function parseDarwinCliProcessProbeOutput(output: string, root: string): CliProcessMatch[] {
  const needle = root.toLowerCase()
  if (!needle) return []
  const matches: CliProcessMatch[] = []
  for (const line of output.split('\n')) {
    const entry = line.trim()
    if (!entry) continue
    const separator = entry.indexOf(' ')
    if (separator <= 0) continue
    const processId = Number.parseInt(entry.slice(0, separator), 10)
    if (!Number.isInteger(processId) || processId <= 0) continue
    const args = entry.slice(separator + 1).trim()
    if (!args.toLowerCase().includes(needle)) continue
    const [image] = args.split(' ')
    matches.push({
      processId,
      name: image ? path.basename(image) : '',
      executablePath: image && image.toLowerCase().startsWith(needle) ? image : '',
    })
  }
  return matches
}

/**
 * The probed directory is the CLI's own package directory, not the npm prefix
 * and not its bin directory: a shared global bin holds every other npm CLI the
 * user installed, and matching there would report Gemini as "Claude Code is
 * running". Both process shapes live under the package — a native binary is
 * the image itself, a node-hosted one puts its entry script on the command
 * line.
 */
export function cliPackageDirectory(nodeModulesRoot: string, packageName: string): string {
  return path.join(nodeModulesRoot, ...packageName.split('/'))
}

export function managedCliPackageDirectory(
  npmPrefix: string,
  packageName: string,
  platform: NodeJS.Platform,
): string {
  const nodeModules = platform === 'darwin'
    ? path.join(npmPrefix, 'lib', 'node_modules')
    : path.join(npmPrefix, 'node_modules')
  return cliPackageDirectory(nodeModules, packageName)
}

export interface ProbeRunningCliProcessesOptions {
  platform?: NodeJS.Platform
  /**
   * Overrides the spawn used to reach `powershell.exe` / `/bin/ps`. Tests inject
   * the real probe on the platform they run on; production never passes it.
   */
  runProbe?: (
    executable: string,
    argv: string[],
    options: { env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number },
  ) => Promise<string>
  timeoutMs?: number
}

async function runDefaultProbe(
  executable: string,
  argv: string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number },
): Promise<string> {
  const { stdout } = await execFileAsync(executable, argv, {
    env: options.env,
    windowsHide: true,
    timeout: options.timeoutMs,
    maxBuffer: options.maxOutputBytes,
  })
  return stdout
}

/**
 * Never throws and never blocks the update: a machine where the probe is denied
 * or times out still gets its update attempt, it just does not get the extra
 * sentence. `unavailable` is what the caller logs; it is not a failure the user
 * needs to read about.
 */
export async function probeRunningCliProcesses(
  packageRoot: string,
  options: ProbeRunningCliProcessesOptions = {},
): Promise<CliProcessProbe> {
  const platform = options.platform ?? process.platform
  const root = packageRoot ? path.resolve(packageRoot) : ''
  if (!root) return { status: 'unsupported', processes: [], detail: '未确定该工具的安装目录' }
  if (platform !== 'win32' && platform !== 'darwin') {
    return { status: 'unsupported', processes: [], detail: `当前平台不做进程检测：${platform}` }
  }
  const runProbe = options.runProbe ?? runDefaultProbe
  const timeoutMs = options.timeoutMs ?? 8_000
  try {
    if (platform === 'win32') {
      const stdout = await runProbe(
        resolveWindowsPowerShellExecutable(),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', buildWindowsCliProcessProbeScript()],
        {
          env: { ...trustedCommandEnvironment(), [cliProcessRootEnvironmentVariable]: root },
          timeoutMs,
          maxOutputBytes: 1024 * 1024,
        },
      )
      return { status: 'checked', processes: parseWindowsCliProcessProbeOutput(stdout) }
    }
    const { executable, argv } = buildDarwinCliProcessProbeArgv()
    const stdout = await runProbe(executable, argv, {
      env: trustedCommandEnvironment(),
      timeoutMs,
      maxOutputBytes: 4 * 1024 * 1024,
    })
    return { status: 'checked', processes: parseDarwinCliProcessProbeOutput(stdout, root) }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { status: 'unavailable', processes: [], detail: detail.slice(0, 200) }
  }
}

export type FileLockErrorCode = 'EBUSY' | 'ETXTBSY' | 'EPERM' | 'EACCES'

const definiteFileLockCodes = new Set<string>(['EBUSY', 'ETXTBSY'])
const ambiguousFileLockCodes = new Set<string>(['EPERM', 'EACCES'])

/**
 * EBUSY / ETXTBSY mean "something holds this file" and nothing else. EPERM and
 * EACCES are genuinely ambiguous on Windows — a MoveFile over a directory with
 * a mapped image reports ERROR_ACCESS_DENIED just like a missing ACL does — so
 * they are only ever reported as occupancy when a probe actually found the
 * CLI's own process. Guessing would send the user to the wrong place again,
 * only in the other direction.
 */
export function fileLockErrorCode(error: unknown): FileLockErrorCode | null {
  const code = extractErrorCode(error)
  if (!code) return null
  if (definiteFileLockCodes.has(code)) return code as FileLockErrorCode
  if (ambiguousFileLockCodes.has(code)) return code as FileLockErrorCode
  return null
}

export function isDefiniteFileLockError(error: unknown): boolean {
  const code = extractErrorCode(error)
  return code !== null && definiteFileLockCodes.has(code)
}

function extractErrorCode(error: unknown): string | null {
  for (let current: unknown = error, depth = 0; current && depth < 4; depth += 1) {
    if (typeof current !== 'object') break
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string' && code) return code.toUpperCase()
    current = (current as { cause?: unknown }).cause
  }
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const found = /\b(EBUSY|ETXTBSY|EPERM|EACCES)\b/.exec(message)
  return found ? found[1]! : null
}

export interface OccupiedUpdateFailureInput {
  toolName: string
  action: '安装' | '更新'
  error: unknown
  probe: CliProcessProbe
  detail?: string
}

/**
 * 「文件被占用」是给渲染层的归类钩子（`src/renderer-v2/operation-error.ts` 的
 * toolRunning 认这几个字），进程数只有真数到了才写——「可能正在运行」和「正在
 * 运行（2 个进程）」对用户是两句不同的话，不许用前者的语气说后者的事。
 *
 * EPERM / EACCES 本身两说，所以只有数到这个工具的进程才改写；数不到就返回 null，
 * 让「需要管理员权限」照原样出去。把「没有权限」说成「工具正在运行」只是换个方向
 * 骗人。原始报错一定留在句尾：客服排查要的是它。
 */
export function describeOccupiedUpdateFailure(input: OccupiedUpdateFailureInput): string | null {
  const running = input.probe.processes.length
  if (!isDefiniteFileLockError(input.error) && running === 0) return null
  const cause = running > 0
    ? `检测到 ${input.toolName} 正在运行（${running} 个进程），请关掉它的窗口再试`
    : `${input.toolName} 可能正在运行，请关掉正在使用它的窗口再试`
  const detail = input.detail?.trim()
  return `${input.toolName} ${input.action}失败：文件被占用，${cause}。${detail ? `原始报错：${detail}` : ''}`
}

/**
 * The line the install dialog shows before npm starts. It is a heads-up, not a
 * gate: a probe can only see processes, it cannot know whether this particular
 * one will hold the file, and refusing an update the user asked for on that
 * guess would be worse than letting it fail with a clear message.
 */
export function describeRunningCliProcessWarning(toolName: string, probe: CliProcessProbe): string | null {
  if (probe.status !== 'checked' || probe.processes.length === 0) return null
  return `检测到 ${toolName} 正在运行（${probe.processes.length} 个进程）。建议先关掉它的窗口，否则更新可能因文件被占用而失败。`
}

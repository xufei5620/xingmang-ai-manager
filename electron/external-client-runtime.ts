import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  cleanCommandOutput, CommandRunnerError, runCommand, trustedCommandEnvironment,
  type CommandSpec, type RunCommandOptions,
} from './command-runner'
import { isExternalToolId, type ExternalClientInstallProgress, type ExternalClientRuntimeStatus } from './external-client-contract'
import type { ExternalToolId } from './external-tool-config'
import { InstallationQueue } from './installation-queue'
import { darwinDeveloperIdVerificationArgv } from './macos-code-signing'
import { resolveSystemWingetExecutable, type SystemWingetResolution } from './node-runtime'
import { sameLocalPathIdentity } from './path-identity'
import { assertNoReparseComponents } from './safe-local-data'
import { resolveWindowsExplorerExecutable } from './system-shell'
import { encodeWindowsPowerShellCommand, resolveWindowsPowerShellExecutable, type WindowsCliExecutionMode } from './windows-elevation'
import { pathWithinWindowsRoot, resolveWindowsMachinePaths, type WindowsMachinePaths } from './windows-machine-paths'
import { installWorkBuddyFromOfficial } from './workbuddy-installer'

const tools: readonly ExternalToolId[] = ['workbuddy', 'claudeDesktop', 'opencode']
const definitions = {
  workbuddy: { name: 'WorkBuddy', winget: 'Tencent.WorkBuddy', executable: 'WorkBuddy.exe', bundle: 'WorkBuddy.app', bundleId: 'com.tencent.workbuddy.mac' },
  claudeDesktop: { name: 'Claude Desktop', winget: 'Anthropic.Claude', executable: 'Claude.exe', bundle: 'Claude.app', bundleId: 'com.anthropic.claudefordesktop' },
  opencode: { name: 'OpenCode', winget: 'SST.OpenCodeDesktop', executable: 'OpenCode.exe', bundle: 'OpenCode.app', bundleId: 'ai.opencode.desktop' },
} as const
const claudeFamily = 'Claude_pzs8sxrjxfjjc'
const claudeApplicationId = `${claudeFamily}!Claude`
const maximumProbeBytes = 256 * 1024
// 老电脑上这一轮 PowerShell 盘点（注册表、进程、AppX、签名）要好几秒，而装没装
// 客户端这件事几分钟内几乎不会变；装、卸、打开之后会主动作废。
const defaultScanCacheTtlMs = 5 * 60_000
const maximumKnownSignatures = 32
const publisherPatterns: Record<ExternalToolId, RegExp> = {
  workbuddy: /(?:^|,\s*)(?:CN|O)="?Tencent Technology \(Shenzhen\) Company Limited"?(?:,|$)/i,
  claudeDesktop: /(?:^|,\s*)(?:CN|O)="Anthropic, PBC"(?:,|$)/i,
  opencode: /(?:^|,\s*)(?:CN|O)="Anomaly Innovations, Inc https:\/\/anoma\.ly\/"(?:,|$)/i,
}

interface LocatedClient {
  tool: ExternalToolId
  path: string
  version: string | null
  running: boolean
  applicationId?: string
}
interface Inspection { clients: LocatedClient[]; errors: Partial<Record<ExternalToolId, string>> }
interface LaunchPlan extends CommandSpec { cwd?: string; env: NodeJS.ProcessEnv; windowsHide: boolean }

export interface ExternalClientRuntimeOptions {
  installationQueue?: InstallationQueue
  platform?: NodeJS.Platform
  architecture?: NodeJS.Architecture
  userHome?: string
  env?: NodeJS.ProcessEnv
  windowsExecutionMode?: WindowsCliExecutionMode
  runCommand?: typeof runCommand
  resolveWingetExecutable?: () => Promise<SystemWingetResolution>
  resolveMachinePaths?: () => WindowsMachinePaths
  resolveExplorerExecutable?: () => string
  resolvePowerShellExecutable?: () => string
  /** Test seams keep installation and launch tests entirely outside the host machine. */
  verifyPath?: (candidate: string, kind: 'file' | 'directory' | 'appx-file') => Promise<string>
  launchProcess?: (plan: LaunchPlan) => Promise<void>
  installWorkBuddyFromOfficial?: typeof installWorkBuddyFromOfficial
  getuid?: () => number
  /** 同一份盘点结果复用多久；缺省 5 分钟。测试用假时钟时一并注入 now。 */
  scanCacheTtlMs?: number
  now?: () => number
}

export interface ExternalClientScanOptions {
  /** 用户亲手点「重新检测」：不用缓存里那份，但仍与正在跑的那次合并。 */
  force?: boolean
}

/** A signature verdict the inventory script may reuse while the file stamp is unchanged. */
export interface KnownExternalClientSignature {
  path: string
  stamp: string
  status: string
  subject: string
}

function errorText(error: unknown): string {
  return cleanCommandOutput(error instanceof Error ? error.message : String(error)).slice(0, 1500)
}

function wingetNetworkFailure(error: unknown): boolean {
  if (!(error instanceof CommandRunnerError) || error.code !== 'EXIT_NON_ZERO' || error.exitCode === null || error.signal) return false
  // WinINet timeout, name resolution, connection and connection-reset failures.
  return [0x80072ee2, 0x80072ee7, 0x80072efd, 0x80072efe, 0x80072eff].includes(error.exitCode >>> 0)
}

function wingetFailureMessage(error: unknown): string {
  if (!(error instanceof CommandRunnerError)) return errorText(error)
  const exitCode = error.exitCode === null ? '' : `（错误码 0x${(error.exitCode >>> 0).toString(16)}）`
  if (wingetNetworkFailure(error)) return `winget 无法连接软件源或下载服务器${exitCode}，请检查网络连接后重试。`
  if (error.code === 'ABORTED' || error.exitCode !== null && [1223, 0x800704c7].includes(error.exitCode >>> 0)) return '安装已取消。'
  if (error.code === 'TIMED_OUT') return 'winget 安装超时，请重新检测客户端状态后再尝试安装。'
  return `winget 安装失败${exitCode}，请查看运行日志中的安装器输出。`
}

function installationError(message: string, originalError: unknown): Error {
  return Object.assign(new Error(message), { originalError })
}
function textValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() && value.length < 32_768 && !/[\x00-\x1f]/.test(value) ? value.trim() : null
}
function versionValue(value: unknown): string | null {
  const result = textValue(value)
  return result && /^[0-9][0-9A-Za-z.+_-]{0,100}$/.test(result) ? result : null
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('客户端检测结果格式无效')
  return value as Record<string, unknown>
}
function localWindowsPath(value: string): boolean {
  return /^[a-z]:\\/i.test(value) && !/[<>"|?*\x00-\x1f]/.test(value) && !value.slice(2).includes(':')
}

export async function verifyExternalClientPath(candidate: string, kind: 'file' | 'directory' | 'appx-file'): Promise<string> {
  if (kind === 'appx-file') {
    // WindowsApps itself denies native realpath to normal users, while the
    // registered package and its executable remain accessible. Compare the
    // complete path identity (including lstat of each component), rather than
    // requiring a native realpath handle on every parent directory.
    if (!sameLocalPathIdentity(candidate, candidate)) throw new Error('客户端 AppX 路径身份无法验证')
  } else assertNoReparseComponents(candidate, '客户端安装路径')
  const stats = await fs.promises.lstat(candidate)
  if (stats.isSymbolicLink() || (kind === 'directory' ? !stats.isDirectory() : !stats.isFile() || (kind !== 'appx-file' && stats.nlink !== 1))) {
    throw new Error('客户端安装路径不是普通文件或目录')
  }
  return fs.promises.realpath(candidate)
}

// Read registry metadata and current-user AppX registration only. Never execute a
// discovered application's --version, uninstall string, or registry command line.
//
// `knownSignatures` lets a display-only scan skip Get-AuthenticodeSignature for an
// executable whose size and timestamps are unchanged since it was last verified.
// The list is passed as base64 JSON so no path or subject text ever becomes
// PowerShell source. A same-user attacker can forge those timestamps, so install
// and launch never pass this list: anything that acts on the file verifies anew.
export function windowsExternalClientInventoryScript(knownSignatures: readonly KnownExternalClientSignature[] = []): string {
  const known = Buffer.from(JSON.stringify(knownSignatures.map(({ path: file, stamp, status, subject }) => ({ path: file, stamp, status, subject }))), 'utf8').toString('base64')
  return String.raw`
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ErrorActionPreference = 'Stop'
$knownSignatures = @{}
# Windows PowerShell 5.1 emits a JSON array as one pipeline object; assigning it
# first and then iterating enumerates the entries on every PowerShell version.
$knownList = ConvertFrom-Json ([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${known}')))
foreach ($entry in $knownList) {
  if ($entry -and $entry.path) { $knownSignatures[[string]$entry.path] = $entry }
}
$clients = [System.Collections.Generic.List[object]]::new()
$errors = @{}
$registry = [System.Collections.Generic.List[object]]::new()
function Test-LocalExecutablePath([string]$candidate) {
  # Registry entries are user writable. Reject remote paths, alternate streams
  # and reparse parents before reading metadata or a signature from them.
  if ($candidate -notmatch '^[A-Za-z]:\\' -or $candidate.Substring(2) -match '[:<>"|?*\x00-\x1f]') { return $false }
  try {
    $full = [System.IO.Path]::GetFullPath($candidate)
    if ($full -ine $candidate) { return $false }
    $cursor = [System.IO.Path]::GetPathRoot($full)
    foreach ($segment in $full.Substring($cursor.Length).Split('\')) {
      if (!$segment) { continue }
      $cursor = Join-Path $cursor $segment
      $item = Get-Item -LiteralPath $cursor -Force
      if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { return $false }
    }
    return !$item.PSIsContainer
  } catch { return $false }
}
$roots = @('Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'Registry::HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'Registry::HKEY_LOCAL_MACHINE\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')
$registryIncomplete = $false
foreach ($root in $roots) {
  try {
    if (Test-Path -LiteralPath $root) {
      foreach ($key in Get-ChildItem -LiteralPath $root) {
        try { $registry.Add((Get-ItemProperty -LiteralPath $key.PSPath)) }
        catch { $registryIncomplete = $true }
      }
    }
  } catch { $registryIncomplete = $true }
}
$processes = @(Get-Process -Name WorkBuddy,Claude,OpenCode -ErrorAction SilentlyContinue | ForEach-Object { try { $_.Path } catch {} })
$products = @(
  @{ tool='workbuddy'; code='BFD312E9-1019-4F57-9F44-F86246833B50'; name='^WorkBuddy(?:\s|$)'; exe='WorkBuddy.exe' },
  @{ tool='claudeDesktop'; code='AnthropicClaude'; name='^Claude$'; exe='Claude.exe' },
  @{ tool='opencode'; code='d074f30d-5f88-5885-b075-be1348cc7676'; name='^OpenCode$'; exe='OpenCode.exe' }
)
try {
  foreach ($package in @(Get-AppxPackage -Name Claude)) {
    if ($package.PackageFamilyName -ceq 'Claude_pzs8sxrjxfjjc') {
      $exe = Join-Path $package.InstallLocation 'app\Claude.exe'
      $clients.Add([pscustomobject]@{ tool='claudeDesktop'; path=$exe; version=[string]$package.Version; running=($processes -contains $exe); family=[string]$package.PackageFamilyName; publisher=[string]$package.Publisher; installLocation=[string]$package.InstallLocation; applicationId='Claude_pzs8sxrjxfjjc!Claude' })
    }
  }
} catch { $errors.claudeDesktop = '无法读取当前用户 Claude 桌面端的 AppX 注册信息：' + $_.Exception.Message }
foreach ($product in $products) {
  if ($registryIncomplete -and !$errors.ContainsKey($product.tool)) {
    $errors[$product.tool] = '部分软件安装记录无法读取，暂时不能确认客户端是否未安装，请重试检测'
  }
  foreach ($entry in $registry) {
    $keyName = ([string]$entry.PSChildName).Trim('{}')
    if ($keyName -ine $product.code -and [string]$entry.DisplayName -notmatch $product.name) { continue }
    $paths = [System.Collections.Generic.List[string]]::new()
    if ($entry.InstallLocation) { $paths.Add((Join-Path ([string]$entry.InstallLocation).Trim('"') $product.exe)) }
    $icon = [string]$entry.DisplayIcon
    if ($icon -match '^"([^"\r\n]+\.exe)"(?:,[-\d]+)?$') { $paths.Add($Matches[1]) }
    elseif ($icon -match '^([^"\r\n]+\.exe)(?:,[-\d]+)?$') { $paths.Add($Matches[1]) }
    foreach ($exe in @($paths | Select-Object -Unique)) {
      if ([System.IO.Path]::GetFileName($exe) -ine $product.exe -or !(Test-LocalExecutablePath $exe)) { continue }
      try {
        $file = Get-Item -LiteralPath $exe -Force
        $stamp = '{0}:{1}:{2}' -f $file.Length, $file.LastWriteTimeUtc.Ticks, $file.CreationTimeUtc.Ticks
        $known = $knownSignatures[$exe]
        if ($known -and [string]$known.stamp -ceq $stamp) {
          $signatureStatus = [string]$known.status
          $signatureSubject = [string]$known.subject
        } else {
          $signature = Get-AuthenticodeSignature -LiteralPath $exe
          $signatureStatus = [string]$signature.Status
          $signatureSubject = [string]$signature.SignerCertificate.Subject
        }
        $clients.Add([pscustomobject]@{ tool=$product.tool; path=$exe; version=[string]$entry.DisplayVersion; running=($processes -contains $exe); signatureStatus=$signatureStatus; signatureSubject=$signatureSubject; signatureStamp=$stamp })
      } catch { $errors[$product.tool] = '无法读取客户端数字签名：' + $_.Exception.Message }
    }
  }
}
@{ clients=@($clients.ToArray()); errors=$errors } | ConvertTo-Json -Depth 5 -Compress
`.trim()
}

export function buildExternalClientWingetInstall(tool: ExternalToolId, executable: string): CommandSpec {
  if (!isExternalToolId(tool)) throw new Error('未知客户端')
  return {
    executable,
    argv: ['install', '--id', definitions[tool].winget, '--exact', '--source', 'winget', '--scope', 'user', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'],
  }
}

function launchDetached(plan: LaunchPlan): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(plan.executable, [...plan.argv], {
      cwd: plan.cwd, env: plan.env, shell: false, detached: true,
      stdio: 'ignore', windowsHide: plan.windowsHide,
    })
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); resolve() })
  })
}

export function createExternalClientRuntime(options: ExternalClientRuntimeOptions = {}) {
  const platform = options.platform ?? process.platform
  const architecture = options.architecture ?? process.arch
  const userHome = options.userHome ?? os.homedir()
  const execute = options.runCommand ?? runCommand
  const verifyPath = options.verifyPath ?? verifyExternalClientPath
  const queue = options.installationQueue ?? new InstallationQueue()
  const launchProcess = options.launchProcess ?? launchDetached
  const resolveMachinePaths = options.resolveMachinePaths ?? resolveWindowsMachinePaths
  const jobs = new Map<ExternalToolId, { promise: Promise<ExternalClientRuntimeStatus>; observers: Set<(event: ExternalClientInstallProgress) => void>; last: ExternalClientInstallProgress | null }>()
  let inFlightScan: Promise<ExternalClientRuntimeStatus[]> | null = null
  const now = options.now ?? Date.now
  const scanCacheTtlMs = options.scanCacheTtlMs ?? defaultScanCacheTtlMs
  let cachedScan: { statuses: ExternalClientRuntimeStatus[]; at: number } | null = null
  // 装、卸、打开都会让在飞的那次盘点过时：它的结果照样交给等它的人，但不落进缓存。
  let scanGeneration = 0
  const knownSignatures = new Map<string, KnownExternalClientSignature>()

  const environment = () => trustedCommandEnvironment(options.env, platform === 'win32' ? resolveMachinePaths() : undefined, platform)
  const systemOptions = (): RunCommandOptions => ({ env: environment(), trustedOnly: true, timeoutMs: 15_000, maxOutputBytes: maximumProbeBytes, windowsHide: true })
  const noInstallHint = (tool: ExternalToolId): string | null => {
    if (platform === 'win32') return architecture === 'x64' || (architecture === 'arm64' && tool !== 'workbuddy') ? null : '当前处理器架构没有可用的官方 Windows 安装包'
    if (platform === 'darwin') return 'macOS 请先从客户端官网下载并将应用移入 Applications，然后重新检测'
    return '工具箱当前不支持此系统的桌面客户端安装与启动，请使用客户端官网提供的平台安装方案'
  }
  const resolveWinget = async (): Promise<SystemWingetResolution> => {
    if (platform !== 'win32') return { executable: null, reason: null }
    try { return await (options.resolveWingetExecutable ?? resolveSystemWingetExecutable)() }
    catch (error) { return { executable: null, reason: errorText(error) } }
  }

  function rememberSignature(item: Record<string, unknown>) {
    const file = textValue(item.path)
    const stamp = textValue(item.signatureStamp)
    if (!file || !stamp || !/^\d{1,20}:\d{1,20}:\d{1,20}$/.test(stamp)) return
    if (knownSignatures.size >= maximumKnownSignatures) knownSignatures.clear()
    knownSignatures.set(file.toLowerCase(), { path: file, stamp, status: textValue(item.signatureStatus) ?? '', subject: textValue(item.signatureSubject) ?? '' })
  }

  async function inspectWindows(reuseSignatures: boolean): Promise<Inspection> {
    const script = windowsExternalClientInventoryScript(reuseSignatures ? [...knownSignatures.values()] : [])
    const result = await execute({ executable: options.resolvePowerShellExecutable?.() ?? resolveWindowsPowerShellExecutable({ platform, machinePaths: resolveMachinePaths() }), argv: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodeWindowsPowerShellCommand(script)] }, systemOptions())
    const data = record(JSON.parse(cleanCommandOutput(result.stdout).trim()) as unknown)
    if (!Array.isArray(data.clients)) throw new Error('客户端安装检测未返回有效列表')
    const errors: Inspection['errors'] = {}
    if (data.errors !== undefined) {
      const rawErrors = record(data.errors)
      for (const tool of tools) if (textValue(rawErrors[tool])) errors[tool] = textValue(rawErrors[tool])!
    }
    const clients: LocatedClient[] = []
    for (const raw of data.clients.slice(0, 100)) {
      const item = record(raw)
      if (!isExternalToolId(item.tool)) continue
      const tool = item.tool
      if (item.family === undefined) rememberSignature(item)
      try {
        const candidate = textValue(item.path)
        if (!candidate || !localWindowsPath(candidate) || path.win32.basename(candidate).toLowerCase() !== definitions[tool].executable.toLowerCase()) throw new Error('客户端可执行文件路径无效')
        const canonical = await verifyPath(candidate, item.family !== undefined ? 'appx-file' : 'file')
        if (path.win32.normalize(canonical).toLowerCase() !== path.win32.normalize(candidate).toLowerCase()) throw new Error('客户端路径经过符号链接或目录联接')
        let applicationId: string | undefined
        if (item.family !== undefined) {
          const location = textValue(item.installLocation)
          const publisher = textValue(item.publisher)
          if (tool !== 'claudeDesktop' || item.family !== claudeFamily || item.applicationId !== claudeApplicationId
            || !publisher || !/(?:^|,\s*)(?:CN|O)="Anthropic, PBC"(?:,|$)/i.test(publisher)
            || !location || !localWindowsPath(location)
            || !pathWithinWindowsRoot(location, path.win32.join(resolveMachinePaths().programFiles, 'WindowsApps'))
            || path.win32.dirname(location).toLowerCase() !== path.win32.join(resolveMachinePaths().programFiles, 'WindowsApps').toLowerCase()
            || !/^Claude_\d+(?:\.\d+){3}_(?:x64|arm64|neutral)__pzs8sxrjxfjjc$/i.test(path.win32.basename(location))
            || path.win32.relative(location, canonical).toLowerCase() !== 'app\\claude.exe') throw new Error('Claude 桌面端 AppX 身份或安装路径不可信')
          applicationId = claudeApplicationId
        } else if (item.signatureStatus !== 'Valid' || !publisherPatterns[tool].test(textValue(item.signatureSubject) ?? '')) {
          throw new Error('客户端数字签名无效或签名发布者与官方发布者不一致')
        }
        clients.push({ tool, path: canonical, version: versionValue(item.version), running: item.running === true, ...(applicationId ? { applicationId } : {}) })
      } catch (error) { errors[tool] = errorText(error) }
    }
    for (const client of clients) delete errors[client.tool]
    return { clients, errors }
  }

  async function inspectMac(): Promise<Inspection> {
    const clients: LocatedClient[] = []
    const errors: Inspection['errors'] = {}
    for (const tool of tools) {
      const definition = definitions[tool]
      for (const directory of ['/Applications', path.posix.join(userHome, 'Applications')]) {
        const candidate = path.posix.join(directory, definition.bundle)
        try {
          const canonical = await verifyPath(candidate, 'directory')
          const info = await verifyPath(path.posix.join(canonical, 'Contents', 'Info.plist'), 'file')
          // `systemOptions()` defaults to trustedOnly for the Windows inventory probe,
          // where it resolves the executable from a trusted system directory and rejects
          // user-writable argument paths. On POSIX runCommand only swaps the environment
          // for that flag and drops the path checks silently, so leaving it on here would
          // advertise a guarantee macOS never gets. Every darwin probe passes the already
          // sanitized trusted environment explicitly and turns the flag off.
          const result = await execute({ executable: '/usr/bin/plutil', argv: ['-convert', 'json', '-o', '-', info] }, { ...systemOptions(), trustedOnly: false })
          const data = record(JSON.parse(result.stdout) as unknown)
          if (definition.bundleId && data.CFBundleIdentifier !== definition.bundleId) throw new Error('应用的 bundle identifier 与官方客户端不一致')
          // LaunchServices performs the launch as the current user. Gatekeeper
          // checks the entire application; no guessed Team ID is used as proof.
          await execute({ executable: '/usr/sbin/spctl', argv: ['--assess', '--type', 'execute', canonical] }, { ...systemOptions(), trustedOnly: false, timeoutMs: 20_000 })
          if (tool === 'workbuddy') await execute({ executable: '/usr/bin/codesign', argv: darwinDeveloperIdVerificationArgv('FN2V63AD2J', canonical, { deep: true, bundleIdentifier: definition.bundleId }) }, { ...systemOptions(), trustedOnly: false, timeoutMs: 20_000 })
          const processes = await execute({ executable: '/bin/ps', argv: ['-axo', 'comm='] }, { ...systemOptions(), trustedOnly: false })
          const running = processes.stdout.split(/\r?\n/).some((line) => line.trim().startsWith(`${canonical}/Contents/MacOS/`))
          clients.push({ tool, path: canonical, version: versionValue(data.CFBundleShortVersionString), running })
          delete errors[tool]
          break
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors[tool] = errorText(error)
        }
      }
    }
    return { clients, errors }
  }

  async function inspect(reuseSignatures = false): Promise<Inspection> {
    try { return platform === 'win32' ? await inspectWindows(reuseSignatures) : platform === 'darwin' ? await inspectMac() : { clients: [], errors: {} } }
    catch (error) { return { clients: [], errors: Object.fromEntries(tools.map((tool) => [tool, errorText(error)])) } }
  }
  function status(tool: ExternalToolId, inspection: Inspection, winget: SystemWingetResolution): ExternalClientRuntimeStatus {
    const client = inspection.clients.find((item) => item.tool === tool)
    const platformHint = noInstallHint(tool)
    const officialDownload = platform === 'win32' && architecture === 'x64' && tool === 'workbuddy'
    const hint = platformHint ?? (!winget.executable ? officialDownload ? '将使用腾讯官方安装包' : winget.reason || '未找到受信任的系统 winget，请安装或修复 Microsoft App Installer 后重新检测' : null)
    return {
      tool, installed: Boolean(client), version: client?.version ?? null, path: client?.path ?? null,
      installDirectory: client ? (platform === 'win32' ? path.win32.dirname(client.path) : client.path) : null,
      running: client?.running ?? false, installSupported: platform === 'win32' && platformHint === null && Boolean(winget.executable || officialDownload),
      launchSupported: Boolean(client) && (platform === 'win32' || (platform === 'darwin' && (options.getuid?.() ?? process.getuid?.() ?? 1) !== 0)),
      detectionError: inspection.errors[tool] ?? null, installHint: hint,
    }
  }
  function invalidateScan() {
    scanGeneration++
    cachedScan = null
  }
  function scan(scanOptions: ExternalClientScanOptions = {}): Promise<ExternalClientRuntimeStatus[]> {
    if (inFlightScan) return inFlightScan
    if (!scanOptions.force && cachedScan && now() - cachedScan.at < scanCacheTtlMs) return Promise.resolve(cachedScan.statuses)
    const generation = scanGeneration
    const promise = Promise.all([inspect(true), resolveWinget()]).then(([inspection, winget]) => {
      const statuses = tools.map((tool) => status(tool, inspection, winget))
      // 检测出错的那次不缓存：老电脑上一次 PowerShell 超时不该让界面连着几分钟报错。
      if (generation === scanGeneration && statuses.every((entry) => !entry.detectionError)) cachedScan = { statuses, at: now() }
      return statuses
    })
    inFlightScan = promise
    void promise.then(() => { if (inFlightScan === promise) inFlightScan = null }, () => { if (inFlightScan === promise) inFlightScan = null })
    return promise
  }
  function install(tool: ExternalToolId, onProgress?: (event: ExternalClientInstallProgress) => void): Promise<ExternalClientRuntimeStatus> {
    if (!isExternalToolId(tool)) return Promise.reject(new Error('未知客户端'))
    const existing = jobs.get(tool)
    if (existing) {
      if (onProgress) { existing.observers.add(onProgress); if (existing.last) { try { onProgress(existing.last) } catch { /* Observer errors cannot interrupt installation. */ } } }
      return existing.promise
    }
    const observers = new Set(onProgress ? [onProgress] : [])
    const job = { promise: null as unknown as Promise<ExternalClientRuntimeStatus>, observers, last: null as ExternalClientInstallProgress | null }
    const report = (phase: ExternalClientInstallProgress['phase'], message: string, percent: number | null = null) => {
      job.last = { tool, phase, message, percent }
      for (const observer of observers) { try { observer(job.last) } catch { /* UI failures cannot change an installer outcome. */ } }
    }
    report('queued', `${definitions[tool].name} 已加入安装队列`)
    job.promise = queue.enqueue(`external-client:install:${tool}`, async () => {
      try {
        report('checking', `正在检测 ${definitions[tool].name}`)
        const [before, winget] = await Promise.all([inspect(), resolveWinget()])
        const current = status(tool, before, winget)
        if (current.installed) { report('completed', '客户端已安装，无需重复安装', 100); return current }
        if (current.detectionError) throw new Error(`无法确认当前安装状态：${current.detectionError}`)
        if (!current.installSupported) throw new Error(current.installHint || '当前系统不支持一键安装')
        let officialDownloadNeeded = !winget.executable
        let sourceFailure: unknown
        let installerStarted = false
        let recentOutput = ''
        // The resolver binds winget to Microsoft's protected AppInstaller package.
        // Its WindowsApps ACL is deliberately handled by that resolver, as in
        // node-runtime/python-runtime; never substitute a PATH/AppExecutionAlias.
        if (winget.executable) {
          report('downloading', `正在通过 winget 下载并安装 ${definitions[tool].name}`)
          try {
            await execute(buildExternalClientWingetInstall(tool, winget.executable), {
              env: environment(), trustedOnly: false, windowsHide: true,
              timeoutMs: 15 * 60_000, maxOutputBytes: 2 * 1024 * 1024, acceptedExitCodes: [0],
              onOutput: (event) => {
                const combined = recentOutput + cleanCommandOutput(event.text)
                if (/installing|starting package install|正在安装|开始.*安装/i.test(combined)) {
                  installerStarted = true
                  report('installing', `正在安装 ${definitions[tool].name}`)
                }
                recentOutput = combined.slice(-2048)
              },
            })
          } catch (error) {
            if (tool !== 'workbuddy' || installerStarted || !wingetNetworkFailure(error)) throw installationError(wingetFailureMessage(error), error)
            sourceFailure = error
            const recheck = status(tool, await inspect(), winget)
            if (recheck.detectionError) throw installationError(`winget 连接失败，且无法确认客户端安装状态：${recheck.detectionError}`, error)
            officialDownloadNeeded = !recheck.installed
          }
        }
        if (officialDownloadNeeded) {
          report('downloading', sourceFailure ? 'winget 源连接失败，正在切换到腾讯官方下载' : '正在使用腾讯官方安装包')
          try {
            await (options.installWorkBuddyFromOfficial ?? installWorkBuddyFromOfficial)({
              architecture, windowsExecutionMode: options.windowsExecutionMode ?? 'trusted-only', runCommand: execute,
              onProgress: (event) => report(event.phase, event.message, event.percent),
            })
          } catch (error) {
            throw installationError(`${sourceFailure ? 'winget 源连接失败；' : ''}腾讯官方安装未完成：${errorText(error)}`, { winget: sourceFailure, official: error })
          }
        }
        report('checking', '正在验证安装结果')
        const after = status(tool, await inspect(), winget)
        if (!after.installed) throw new Error(after.detectionError || '安装命令已结束，但未检测到客户端，请检查安装器结果后重试检测')
        report('completed', `${definitions[tool].name} 安装完成`, 100)
        return after
      } catch (error) { report('error', errorText(error)); throw error }
    })
    jobs.set(tool, job)
    void job.promise.then(() => { jobs.delete(tool) }, () => { jobs.delete(tool) })
    // 装成、装失败都作废：失败的安装器也可能已经留下了一半的文件。
    void job.promise.then(invalidateScan, invalidateScan)
    return job.promise
  }
  function launch(tool: ExternalToolId): Promise<void> {
    if (!isExternalToolId(tool)) return Promise.reject(new Error('未知客户端'))
    const launched = queue.enqueue(`external-client:launch:${tool}`, async () => {
      const inspection = await inspect()
      const client = inspection.clients.find((item) => item.tool === tool)
      if (!client) throw new Error(inspection.errors[tool] || '尚未检测到客户端，请先安装并重新检测')
      if (platform === 'win32') {
        const machinePaths = resolveMachinePaths()
        const executable = options.resolveExplorerExecutable?.() ?? resolveWindowsExplorerExecutable({ platform, machinePaths })
        // Reuse the project's Explorer broker boundary for user-installed apps.
        // A signed Electron exe alone does not make writable sibling DLLs safe
        // for an elevated spawn; Explorer delegates to the interactive shell.
        await launchProcess({ executable, argv: [client.applicationId ? `shell:AppsFolder\\${client.applicationId}` : client.path], cwd: machinePaths.systemRoot, env: environment(), windowsHide: true })
      } else if (platform === 'darwin') {
        if ((options.getuid?.() ?? process.getuid?.() ?? 1) === 0) throw new Error('请以普通用户身份重新打开工具箱后启动桌面客户端')
        await execute({ executable: '/usr/bin/open', argv: ['-a', client.path] }, { env: environment(), trustedOnly: false, timeoutMs: 15_000, maxOutputBytes: maximumProbeBytes })
      } else throw new Error('当前系统不支持启动此桌面客户端')
    })
    // 打开之后「正在运行」就变了，下一次检测得重新盘点。
    void launched.then(invalidateScan, invalidateScan)
    return launched
  }
  return { scan, install, launch, invalidateScan }
}

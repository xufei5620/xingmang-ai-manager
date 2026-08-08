import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  compareWindowsPackageVersions,
  parseCodexDesktopAppManifest,
  parseCodexDesktopMirrorManifest,
  parseCodexDesktopPackageMetadata,
  parseCodexDesktopPackagesJson,
  parseStartAppsJson,
  parseWindowsProcessesJson,
  selectCodexDesktopApp,
  selectCodexDesktopPackage,
  stopCodexDesktopProcesses,
  type CodexDesktopMirrorRelease,
  type CodexDesktopPackageEntry,
  type CodexDesktopPackageMetadata,
  type StartAppEntry,
  type WindowsProcessEntry,
} from './codex-desktop'
import { trustedCommandEnvironment, windowsSystemExecutable } from './command-runner'
import { resolveWindowsExplorerExecutable } from './system-shell'
import { resolveWindowsPowerShellExecutable } from './windows-elevation'
import { resolveWindowsMachinePaths } from './windows-machine-paths'

const execFileAsync = promisify(execFile)

const codexDesktopUpdateManifestUrl = 'https://persistent.oaistatic.com/codex-app-prod/windows-store-update.json'
const codexDesktopMirrorManifestUrl = 'https://codexapp.agentsmirror.com/latest/manifest'
const codexDesktopMirrorPackageUrls = {
  x64: 'https://codexapp.agentsmirror.com/latest/win-x64',
  arm64: 'https://codexapp.agentsmirror.com/latest/win-arm64',
} as const
const codexDesktopMirrorHosts = new Set([
  'codexapp.agentsmirror.com',
  'codexapp-r2.agentsmirror.com',
])
const codexDesktopMirrorObjectStorageHost = 'fgws3-ocloud.ihep.ac.cn'
const codexDesktopMirrorObjectStoragePrefix = '/20830-codex'
const codexDesktopMirrorSignedQueryKeys = new Set([
  'X-Amz-Algorithm',
  'X-Amz-Credential',
  'X-Amz-Date',
  'X-Amz-Expires',
  'X-Amz-SignedHeaders',
  'response-content-disposition',
  'response-content-type',
  'X-Amz-Signature',
])
const codexDesktopRedirectStatuses = new Set([301, 302, 303, 307, 308])
const maximumCodexDesktopRedirects = 2
const minimumCodexDesktopPackageBytes = 10 * 1024 * 1024
const maximumCodexDesktopPackageBytes = 1_500 * 1024 * 1024
const maximumCodexDesktopManifestBytes = 1024 * 1024
const maximumCodexDesktopAppManifestBytes = 512 * 1024

export interface CodexDesktopLaunchPlan {
  executable: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  windowsHide: boolean
}

/** Launches the AppsFolder URI through the canonical SystemRoot Explorer. */
export function buildCodexDesktopLaunchPlan(
  appUserModelId: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): CodexDesktopLaunchPlan {
  if (!appUserModelId.trim() || appUserModelId.includes('\0') || appUserModelId.length > 2_048) {
    throw new Error('Codex Desktop 应用标识无效')
  }
  const machinePaths = resolveWindowsMachinePaths()
  const executable = resolveWindowsExplorerExecutable({ platform: 'win32', machinePaths })
  return {
    executable,
    args: [`shell:AppsFolder\\${appUserModelId}`],
    cwd: machinePaths.systemRoot,
    env: trustedCommandEnvironment(baseEnv, machinePaths),
    windowsHide: false,
  }
}

export interface CodexDesktopPackageSource {
  label: string
  url: string
  expectedContentLength?: number
  expectedSha256Base64?: string
}

export interface CodexDesktopDownloadProgress {
  transferred: number
  total: number
  percent: number
}

export interface CodexDesktopDownloadResult {
  transferred: number
  total: number
  sha256Base64: string
}

export interface CodexDesktopManifestSource extends CodexDesktopPackageSource {
  kind: 'official' | 'mirror'
}

function validateCodexDesktopMirrorObjectStorageUrl(parsed: URL, original: URL): boolean {
  if (parsed.hostname !== codexDesktopMirrorObjectStorageHost) return false
  if (parsed.pathname !== `${codexDesktopMirrorObjectStoragePrefix}${original.pathname}`) return false

  let expectedContentType: string
  let expectedFileName: string
  if (original.pathname === '/latest/manifest') {
    expectedContentType = 'application/json'
    expectedFileName = 'release-manifest.json'
  } else {
    const packageMatch = original.pathname.match(/^\/latest\/win-(x64|arm64)$/)
    if (!packageMatch) return false
    expectedContentType = 'application/vnd.ms-appx'
    expectedFileName = `Codex-Windows-${packageMatch[1]}.msix`
  }

  const entries = [...parsed.searchParams.entries()]
  const keys = new Set(entries.map(([key]) => key))
  if (
    entries.length !== codexDesktopMirrorSignedQueryKeys.size
    || keys.size !== entries.length
    || [...keys].some((key) => !codexDesktopMirrorSignedQueryKeys.has(key))
  ) {
    return false
  }

  const credential = parsed.searchParams.get('X-Amz-Credential') ?? ''
  const expires = Number(parsed.searchParams.get('X-Amz-Expires'))
  return parsed.searchParams.get('X-Amz-Algorithm') === 'AWS4-HMAC-SHA256'
    && /^[A-Za-z0-9]{8,128}\/\d{8}\/auto\/s3\/aws4_request$/.test(credential)
    && /^\d{8}T\d{6}Z$/.test(parsed.searchParams.get('X-Amz-Date') ?? '')
    && Number.isSafeInteger(expires)
    && expires >= 1
    && expires <= 3_600
    && parsed.searchParams.get('X-Amz-SignedHeaders') === 'host'
    && parsed.searchParams.get('response-content-disposition') === `attachment; filename="${expectedFileName}"`
    && parsed.searchParams.get('response-content-type') === expectedContentType
    && /^[a-f0-9]{64}$/i.test(parsed.searchParams.get('X-Amz-Signature') ?? '')
}

export function validateCodexDesktopResourceUrl(value: string, originalUrl: string): URL {
  let parsed: URL
  let original: URL
  try {
    parsed = new URL(value)
    original = new URL(originalUrl)
  } catch {
    throw new Error('Codex Desktop 下载地址格式无效')
  }
  const allowedHosts = codexDesktopMirrorHosts.has(original.hostname)
    ? codexDesktopMirrorHosts
    : new Set([original.hostname])
  const staticResource = !parsed.search
    && allowedHosts.has(parsed.hostname)
    && parsed.pathname === original.pathname
  const signedMirrorObject = codexDesktopMirrorHosts.has(original.hostname)
    && validateCodexDesktopMirrorObjectStorageUrl(parsed, original)
  if (
    parsed.protocol !== 'https:'
    || parsed.port
    || parsed.username
    || parsed.password
    || parsed.hash
    || (!staticResource && !signedMirrorObject)
  ) {
    throw new Error('Codex Desktop 下载发生了不受信任的重定向')
  }
  return parsed
}

export async function fetchTrustedCodexDesktopResource(
  sourceUrl: string,
  init: RequestInit,
  fetchImplementation: typeof fetch,
): Promise<Response> {
  const original = validateCodexDesktopResourceUrl(sourceUrl, sourceUrl)
  let current = original
  const visited = new Set<string>()
  for (let redirectCount = 0; redirectCount <= maximumCodexDesktopRedirects; redirectCount += 1) {
    if (visited.has(current.href)) throw new Error('Codex Desktop 下载发生了循环重定向')
    visited.add(current.href)
    const response = await fetchImplementation(current.href, { ...init, redirect: 'manual' })
    if (response.url) {
      const responseUrl = validateCodexDesktopResourceUrl(response.url, original.href)
      if (responseUrl.href !== current.href) {
        throw new Error('Codex Desktop 下载绕过了受限重定向策略')
      }
    }
    if (!codexDesktopRedirectStatuses.has(response.status)) return response
    if (redirectCount === maximumCodexDesktopRedirects) {
      throw new Error('Codex Desktop 下载重定向次数过多')
    }
    const location = response.headers.get('location')
    if (!location) throw new Error('Codex Desktop 下载重定向缺少 Location')
    await response.body?.cancel().catch(() => undefined)
    current = validateCodexDesktopResourceUrl(new URL(location, current).href, original.href)
  }
  throw new Error('Codex Desktop 下载重定向次数过多')
}

export function buildCodexDesktopPackageSources(
  architecture: 'x64' | 'arm64',
): CodexDesktopPackageSource[] {
  return [{ label: '国内镜像', url: codexDesktopMirrorPackageUrls[architecture] }]
}

/**
 * Mirror first, matching the package download, which is mirror-only. Reading
 * the version from the official manifest while the bytes can only come from the
 * mirror let the two disagree: the card could advertise a release the install
 * path had no way to fetch. Both endpoints stay in the list and both still go
 * through fetchTrustedCodexDesktopResource, so this only changes which is tried
 * first, never how either is validated.
 */
export function buildCodexDesktopManifestSources(
): CodexDesktopManifestSource[] {
  return [
    { kind: 'mirror', label: '国内镜像', url: codexDesktopMirrorManifestUrl },
    { kind: 'official', label: 'OpenAI 官方源', url: codexDesktopUpdateManifestUrl },
  ]
}

export async function fetchCodexDesktopMirrorRelease(
  architecture: 'x64' | 'arm64',
  fetchImplementation: typeof fetch = fetch,
): Promise<CodexDesktopMirrorRelease> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await fetchTrustedCodexDesktopResource(codexDesktopMirrorManifestUrl, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    }, fetchImplementation)
    if (!response.ok) throw new Error(`返回 HTTP ${response.status}`)
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    if (!contentType.includes('application/json')) throw new Error('返回的不是 JSON 响应')
    const declaredLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > 256 * 1024) {
      throw new Error('响应超过 256 KB 安全上限')
    }
    if (!response.body) throw new Error('没有响应正文')

    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let received = 0
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      if (!chunk.value?.byteLength) continue
      received += chunk.value.byteLength
      if (received > 256 * 1024) throw new Error('响应超过 256 KB 安全上限')
      chunks.push(chunk.value)
    }
    const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')
    const release = parseCodexDesktopMirrorManifest(text, architecture)
    if (!release) {
      throw new Error('schema、产品 ID、包身份、版本、架构、文件大小或 SHA-256 校验失败')
    }
    return release
  } catch (error) {
    const detail = error instanceof Error && error.name === 'AbortError'
      ? '连接或读取超时'
      : (error instanceof Error ? error.message : String(error))
    throw new Error(`国内镜像清单读取失败：${detail}`)
  } finally {
    clearTimeout(timeout)
  }
}

export async function downloadCodexDesktopPackage(
  source: CodexDesktopPackageSource,
  destination: string,
  onProgress: (progress: CodexDesktopDownloadProgress) => void,
  fetchImplementation: typeof fetch = fetch,
): Promise<CodexDesktopDownloadResult> {
  const controller = new AbortController()
  const responseTimeout = setTimeout(() => controller.abort(), 20_000)
  let file: fs.promises.FileHandle | null = null
  try {
    const response = await fetchTrustedCodexDesktopResource(source.url, {
      headers: { Accept: 'application/vnd.ms-appx, application/octet-stream' },
      signal: controller.signal,
    }, fetchImplementation)
    clearTimeout(responseTimeout)
    if (!response.ok) throw new Error(`${source.label}返回 HTTP ${response.status}`)

    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    if (
      !contentType.includes('application/vnd.ms-appx')
      && !contentType.includes('application/octet-stream')
      && !contentType.includes('binary/octet-stream')
    ) {
      throw new Error(`${source.label}返回的不是 MSIX 文件（Content-Type: ${contentType || '缺失'}）`)
    }

    const total = Number(response.headers.get('content-length'))
    if (!Number.isSafeInteger(total) || total < minimumCodexDesktopPackageBytes) {
      throw new Error(`${source.label}返回的安装包大小无效`)
    }
    if (total > maximumCodexDesktopPackageBytes) {
      throw new Error(`${source.label}返回的安装包超过 1.5 GB 安全上限`)
    }
    if (
      source.expectedContentLength !== undefined
      && total !== source.expectedContentLength
    ) {
      throw new Error(
        `${source.label}返回的 Content-Length 与镜像清单不一致：应为 ${source.expectedContentLength} 字节，实际 ${total} 字节`,
      )
    }
    if (!response.body) throw new Error(`${source.label}未返回安装包内容`)

    file = await fs.promises.open(destination, 'wx', 0o600)
    const reader = response.body.getReader()
    const sha256 = createHash('sha256')
    let transferred = 0
    let lastPercent = -1
    while (true) {
      const idleTimeout = setTimeout(() => controller.abort(), 45_000)
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await reader.read()
      } finally {
        clearTimeout(idleTimeout)
      }
      if (chunk.done) break
      if (!chunk.value?.byteLength) continue
      transferred += chunk.value.byteLength
      if (transferred > total || transferred > maximumCodexDesktopPackageBytes) {
        throw new Error(`${source.label}返回的数据超过声明的安装包大小`)
      }
      sha256.update(chunk.value)
      await file.write(chunk.value)
      const percent = Math.min(100, Math.floor((transferred / total) * 100))
      if (percent !== lastPercent) {
        lastPercent = percent
        onProgress({ transferred, total, percent })
      }
    }
    if (transferred !== total) {
      throw new Error(`${source.label}下载不完整：应为 ${total} 字节，实际 ${transferred} 字节`)
    }
    const sha256Base64 = sha256.digest('base64')
    if (
      source.expectedSha256Base64 !== undefined
      && sha256Base64 !== source.expectedSha256Base64
    ) {
      throw new Error(`${source.label}安装包 SHA-256 与镜像清单不一致，文件可能已损坏`)
    }
    await file.sync()
    return { transferred, total, sha256Base64 }
  } catch (error) {
    const cause = error instanceof Error && error.name === 'AbortError'
      ? new Error(`${source.label}连接或下载超时`)
      : error
    await file?.close().catch(() => undefined)
    file = null
    await fs.promises.rm(destination, { force: true }).catch(() => undefined)
    throw cause
  } finally {
    clearTimeout(responseTimeout)
    await file?.close().catch(() => undefined)
  }
}

export function powershellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

export async function inspectCodexDesktopPackageFile(
  packagePath: string,
): Promise<CodexDesktopPackageMetadata> {
  const script = [
    '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '$ErrorActionPreference = \'Stop\'',
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `$archive = [System.IO.Compression.ZipFile]::OpenRead(${powershellLiteral(packagePath)})`,
    'try {',
    "  $manifestEntry = $archive.Entries | Where-Object { $_.FullName -ieq 'AppxManifest.xml' } | Select-Object -First 1",
    "  $signatureEntry = $archive.Entries | Where-Object { $_.FullName -ieq 'AppxSignature.p7x' } | Select-Object -First 1",
    "  if ($null -eq $manifestEntry) { throw 'MSIX 中缺少 AppxManifest.xml' }",
    `  if ($manifestEntry.Length -le 0 -or $manifestEntry.Length -gt ${maximumCodexDesktopManifestBytes}) { throw 'AppxManifest.xml 大小无效或超过 1 MiB 安全上限' }`,
    '  $stream = $manifestEntry.Open()',
    '  try {',
    '    $settings = [System.Xml.XmlReaderSettings]::new()',
    '    $settings.DtdProcessing = [System.Xml.DtdProcessing]::Prohibit',
    '    $settings.XmlResolver = $null',
    `    $settings.MaxCharactersInDocument = ${maximumCodexDesktopManifestBytes}`,
    '    $reader = [System.Xml.XmlReader]::Create($stream, $settings)',
    '    try {',
    '      $manifest = [System.Xml.XmlDocument]::new()',
    '      $manifest.XmlResolver = $null',
    '      $manifest.Load($reader)',
    '    } finally { $reader.Dispose() }',
    '  } finally { $stream.Dispose() }',
    '  $identity = $manifest.SelectSingleNode(\'/*[local-name()="Package"]/*[local-name()="Identity"]\')',
    "  if ($null -eq $identity) { throw 'AppxManifest.xml 中缺少 Package/Identity' }",
    '  [pscustomobject]@{',
    '    name = [string]$identity.GetAttribute(\'Name\')',
    '    version = [string]$identity.GetAttribute(\'Version\')',
    '    architecture = [string]$identity.GetAttribute(\'ProcessorArchitecture\')',
    '    publisher = [string]$identity.GetAttribute(\'Publisher\')',
    '    hasSignature = ($null -ne $signatureEntry)',
    '  } | ConvertTo-Json -Compress',
    '} finally { $archive.Dispose() }',
  ].join('\n')
  const { stdout } = await execFileAsync(resolveWindowsPowerShellExecutable(), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ], {
    env: trustedCommandEnvironment(),
    windowsHide: true,
    // The first inspection on a machine pays for loading the compression and
    // XML assemblies into a stripped environment, which measurably exceeds 30s
    // on a cold, contended host. Later inspections finish in well under a
    // second. This runs once per package during an install or update the user
    // is already waiting on, so bound it generously rather than failing a
    // healthy package as a timeout.
    timeout: 90_000,
    maxBuffer: 1024 * 1024,
  })
  const metadata = parseCodexDesktopPackageMetadata(stdout)
  if (!metadata) throw new Error('无法读取 Codex Desktop 安装包元数据')
  return metadata
}

export function desktopMirrorUpdateAvailable(
  installedVersion: string | null,
  mirrorVersion: string | null,
): boolean | null {
  if (!mirrorVersion) return null
  if (!installedVersion) return true
  const comparison = compareWindowsPackageVersions(installedVersion, mirrorVersion)
  return comparison === null ? null : comparison < 0
}

export async function findCodexDesktopStartApp(): Promise<StartAppEntry | null> {
  const script = [
    '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    "$apps = @(Get-StartApps | Where-Object { $_.AppID -like 'OpenAI.Codex*!App' } | Select-Object Name, AppID)",
    '$apps | ConvertTo-Json -Compress',
  ].join('\n')

  try {
    const { stdout } = await execFileAsync(resolveWindowsPowerShellExecutable(), [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script,
    ], {
      env: trustedCommandEnvironment(),
      windowsHide: true,
      timeout: 8_000,
      maxBuffer: 1024 * 1024,
    })
    return selectCodexDesktopApp(parseStartAppsJson(stdout))
  } catch {
    return null
  }
}

export async function listCodexDesktopProcesses(): Promise<WindowsProcessEntry[]> {
  if (process.platform !== 'win32') return []

  const script = [
    '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    "$items = @(Get-CimInstance Win32_Process | Where-Object { ([string]$_.ExecutablePath) -like '*\\WindowsApps\\OpenAI.Codex_*' -or ([string]$_.ExecutablePath) -like '*\\WindowsApps\\OpenAI.CodexBeta_*' } | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath)",
    '$items | ConvertTo-Json -Compress',
  ].join('; ')

  try {
    const { stdout } = await execFileAsync(resolveWindowsPowerShellExecutable(), [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script,
    ], {
      env: trustedCommandEnvironment(),
      windowsHide: true,
      timeout: 8_000,
      maxBuffer: 1024 * 1024,
    })
    return parseWindowsProcessesJson(stdout)
  } catch {
    return []
  }
}

export async function inspectCodexDesktopPackage(): Promise<{
  value: CodexDesktopPackageEntry | null
  error: string | null
}> {
  const script = [
    '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    // The packaged app is registered per user. The manager itself runs
    // elevated, so the current-user query can be empty even though the
    // Store package is installed for another Windows account. Prefer the
    // current user, then fall back to the read-only all-users view.
    "$packages = @(Get-AppxPackage -Name 'OpenAI.Codex*' | Select-Object Name, Version, PackageFullName, PackageFamilyName, InstallLocation)",
    "if ($packages.Count -eq 0) { $packages = @(Get-AppxPackage -AllUsers -Name 'OpenAI.Codex*' | Select-Object Name, Version, PackageFullName, PackageFamilyName, InstallLocation) }",
    '$packages | ConvertTo-Json -Compress',
  ].join('; ')

  try {
    const { stdout } = await execFileAsync(resolveWindowsPowerShellExecutable(), [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script,
    ], {
      env: trustedCommandEnvironment(),
      windowsHide: true,
      timeout: 8_000,
      maxBuffer: 1024 * 1024,
    })
    return {
      value: selectCodexDesktopPackage(parseCodexDesktopPackagesJson(stdout)),
      error: null,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message.trim().slice(0, 240) : ''
    return { value: null, error: message || '无法读取 Windows Appx 包信息' }
  }
}

export async function inspectCodexDesktopAppVersion(
  installedPackage: CodexDesktopPackageEntry,
): Promise<string | null> {
  const manifestPath = path.join(
    installedPackage.installLocation,
    'app',
    'resources',
    'app.asar',
    'package.json',
  )
  try {
    // The manifest lives inside app.asar, and Electron's archive layer serves
    // those paths with synthetic stat data - a fresh inode on every call and
    // no timestamps. readBoundedUtf8File's link and TOCTOU guards can never
    // hold there, so they are replaced by the guarantees that do apply: the
    // archive sits under the system-protected WindowsApps directory, and
    // archive members cannot be redirected by a symlink.
    const stats = await fs.promises.stat(manifestPath)
    if (!stats.isFile() || stats.size > maximumCodexDesktopAppManifestBytes) return null
    const manifest = await fs.promises.readFile(manifestPath, 'utf8')
    return parseCodexDesktopAppManifest(manifest)
  } catch {
    return null
  }
}

export async function addCodexDesktopPackage(packagePath: string): Promise<void> {
  const script = [
    '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '$ErrorActionPreference = \'Stop\'',
    `Add-AppxPackage -Path ${powershellLiteral(packagePath)} -ForceApplicationShutdown -ErrorAction Stop`,
  ].join('; ')
  try {
    await execFileAsync(resolveWindowsPowerShellExecutable(), [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script,
    ], {
      env: trustedCommandEnvironment(),
      windowsHide: true,
      timeout: 15 * 60_000,
      maxBuffer: 4 * 1024 * 1024,
    })
  } catch (error) {
    const failure = error as { stderr?: unknown; message?: unknown }
    const stderr = Buffer.isBuffer(failure.stderr)
      ? failure.stderr.toString('utf8')
      : (typeof failure.stderr === 'string' ? failure.stderr : '')
    const message = stderr.trim()
      || (typeof failure.message === 'string' ? failure.message.trim() : '')
      || 'Windows 未返回错误详情'
    throw new Error(`Add-AppxPackage 安装失败：${message.slice(0, 2_000)}`)
  }
}

export async function verifyInstalledCodexDesktop(
  expectedVersion: string,
): Promise<CodexDesktopPackageEntry> {
  const installedProbe = await inspectCodexDesktopPackage()
  if (!installedProbe.value) {
    throw new Error(installedProbe.error ?? '安装命令完成后仍未检测到 Codex Desktop')
  }
  const comparison = compareWindowsPackageVersions(installedProbe.value.version, expectedVersion)
  if (comparison === null || comparison !== 0) {
    throw new Error(
      `安装后检测到的版本 ${installedProbe.value.version} 与目标版本 ${expectedVersion} 不一致`,
    )
  }
  return installedProbe.value
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export async function waitForCodexDesktopState(
  running: boolean,
  timeoutMs: number,
): Promise<WindowsProcessEntry[]> {
  const deadline = Date.now() + timeoutMs
  let processes = await listCodexDesktopProcesses()
  while ((processes.length > 0) !== running && Date.now() < deadline) {
    await delay(250)
    processes = await listCodexDesktopProcesses()
  }
  return processes
}

export async function terminateCodexDesktopProcesses(processes: WindowsProcessEntry[]): Promise<void> {
  const taskkill = async (processId: number, force: boolean): Promise<void> => {
    const args = ['/PID', String(processId), '/T']
    if (force) args.push('/F')
    await execFileAsync(windowsSystemExecutable('taskkill.exe'), args, {
      env: trustedCommandEnvironment(),
      windowsHide: true,
      timeout: 8_000,
    })
  }

  await stopCodexDesktopProcesses(processes, {
    requestClose: (processId) => taskkill(processId, false),
    forceClose: (processId) => taskkill(processId, true),
    waitUntilStopped: (timeoutMs) => waitForCodexDesktopState(false, timeoutMs),
  })
}

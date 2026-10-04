import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { addWindowsDesktopAppxPackage, claudeAppxProduct } from './codex-desktop-appx'
import { cleanCommandOutput, CommandRunnerError, runCommand, trustedCommandEnvironment } from './command-runner'
import { downloadWithResume, DownloadStalledError, type ResumableDownloadOptions } from './download-retry'
import { authenticodeSignatureModules, buildPowerShellPinnedModuleImportStatement } from './powershell-module-imports'
import { createTrustedTemporaryDirectory } from './trusted-temp'
import {
  encodeWindowsPowerShellCommand,
  powerShellLiteral,
  resolveWindowsPowerShellExecutable,
  type WindowsCliExecutionMode,
} from './windows-elevation'
import { resolveWindowsMachinePaths, type WindowsMachinePaths } from './windows-machine-paths'

/**
 * Windows 上 Claude Desktop 的第二路：系统自带的安装组件（winget）没装上，或者这台
 * 电脑根本没有它时，从 Claude 官网下离线安装包（MSIX），在这台电脑上核对是
 * Anthropic 签名的原版，再交给 Windows 装。微软商店里没有 Claude Desktop。
 *
 * 官网入口固定是 claude.ai/api/desktop/win32/<架构>/msix/latest/redirect，它跳到
 * downloads.claude.ai/releases/ 下的安装包；只认这两个主机、这两类路径，与
 * scripts/sync-claude-official-cos.cjs 在 GitHub 的 Windows 机器上核过的范围一致。
 */

const claudeDesktopMsixEntryUrls = {
  x64: 'https://claude.ai/api/desktop/win32/x64/msix/latest/redirect',
  arm64: 'https://claude.ai/api/desktop/win32/arm64/msix/latest/redirect',
} as const
const claudeDesktopRedirectStatuses = new Set([301, 302, 303, 307, 308])
const maximumClaudeDesktopRedirects = 3
const minimumClaudeDesktopPackageBytes = 10 * 1024 * 1024
// 与 codex-desktop-appx.ts 提权副本那一步的上限一致，超过它管理员安装那一步也会拒收。
const maximumClaudeDesktopPackageBytes = 1_500 * 1024 * 1024
const maximumClaudeDesktopManifestBytes = 512 * 1024
// 包家族名 Claude_pzs8sxrjxfjjc 的后半截，是发布者全文算出来的（见 windowsPackagePublisherId）。
// 星芒认已装好的 Claude Desktop 也只认这个家族名（external-client-runtime.ts）。
const claudeDesktopPublisherId = 'pzs8sxrjxfjjc'
const claudeDesktopSignerName = 'Anthropic, PBC'
const crockfordBase32 = '0123456789abcdefghjkmnpqrstvwxyz'
// 签名核对要把整个包读一遍，冷启动的老电脑上要几十秒。
export const claudeDesktopPackageInspectionTimeoutMs = 120_000

export function claudeDesktopMsixEntryUrl(architecture: 'x64' | 'arm64'): string {
  return claudeDesktopMsixEntryUrls[architecture]
}

export function validateClaudeDesktopDownloadUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Claude 官网下载地址格式无效')
  }
  const entry = url.hostname === 'claude.ai'
    && /^\/api\/desktop\/win32\/(?:x64|arm64)\/msix\/latest\/redirect$/.test(url.pathname)
  const release = url.hostname === 'downloads.claude.ai'
    && /^\/releases\/[A-Za-z0-9._~%+\-/]+$/.test(url.pathname)
    && !url.pathname.split('/').some((segment) => segment === '..' || segment === '.')
  if (
    url.protocol !== 'https:'
    || url.port
    || url.username
    || url.password
    || url.search
    || url.hash
    || (!entry && !release)
  ) {
    throw new Error('Claude 官网下载重定向到了没核实过的地址')
  }
  return url
}

/**
 * Windows 给 MSIX 包算的发布者 ID：发布者全文（UTF-16LE）的 SHA-256 取前 8 字节，
 * 末尾补一个 0 位凑成 65 位，按 Crockford Base32 写成 13 个字符。核对它等于核对
 * 清单里的发布者全文，比按名字片段匹配严。
 */
export function windowsPackagePublisherId(publisher: string): string {
  const digest = createHash('sha256').update(Buffer.from(publisher, 'utf16le')).digest()
  let bits = 0n
  for (const byte of digest.subarray(0, 8)) bits = (bits << 8n) | BigInt(byte)
  bits <<= 1n
  let result = ''
  for (let index = 12; index >= 0; index -= 1) {
    result += crockfordBase32[Number((bits >> BigInt(index * 5)) & 31n)]
  }
  return result
}

/**
 * 只读核对：拆开 MSIX 读 AppxManifest.xml 的包身份，再问 Windows 这份包的签名。
 * 包路径是脚本里唯一的外来值，只以单引号字面量出现。
 */
export function buildClaudeDesktopPackageInspectionScript(packagePath: string): string {
  return [
    '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    buildPowerShellPinnedModuleImportStatement(authenticodeSignatureModules),
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `$packagePath = ${powerShellLiteral(packagePath)}`,
    '$archive = [System.IO.Compression.ZipFile]::OpenRead($packagePath)',
    'try {',
    "  $entries = @($archive.Entries | Where-Object { $_.FullName -ieq 'AppxManifest.xml' })",
    `  if ($entries.Count -ne 1 -or $entries[0].Length -le 0 -or $entries[0].Length -gt ${maximumClaudeDesktopManifestBytes}) { throw 'AppxManifest.xml missing or oversized' }`,
    '  $settings = [System.Xml.XmlReaderSettings]::new()',
    '  $settings.DtdProcessing = [System.Xml.DtdProcessing]::Prohibit',
    '  $settings.XmlResolver = $null',
    `  $settings.MaxCharactersInDocument = ${maximumClaudeDesktopManifestBytes}`,
    '  $stream = $entries[0].Open()',
    '  try {',
    '    $reader = [System.Xml.XmlReader]::Create($stream, $settings)',
    '    try {',
    '      $manifest = [System.Xml.XmlDocument]::new()',
    '      $manifest.XmlResolver = $null',
    '      $manifest.Load($reader)',
    '    } finally { $reader.Dispose() }',
    '  } finally { $stream.Dispose() }',
    '  $identity = $manifest.SelectSingleNode(\'/*[local-name()="Package"]/*[local-name()="Identity"]\')',
    "  if ($null -eq $identity) { throw 'Package/Identity missing' }",
    "  $publisher = [string]$identity.GetAttribute('Publisher')",
    '  $publisherCanonical = [System.Security.Cryptography.X509Certificates.X500DistinguishedName]::new($publisher).Decode([System.Security.Cryptography.X509Certificates.X500DistinguishedNameFlags]::UseCommas)',
    "  $hasSignature = $null -ne ($archive.Entries | Where-Object { $_.FullName -ieq 'AppxSignature.p7x' } | Select-Object -First 1)",
    '} finally { $archive.Dispose() }',
    '$signature = Get-AuthenticodeSignature -LiteralPath $packagePath',
    '$signer = $signature.SignerCertificate',
    '[pscustomobject]@{',
    "  name = [string]$identity.GetAttribute('Name')",
    "  version = [string]$identity.GetAttribute('Version')",
    "  architecture = [string]$identity.GetAttribute('ProcessorArchitecture')",
    '  publisher = $publisher',
    '  publisherCanonical = [string]$publisherCanonical',
    '  hasSignature = [bool]$hasSignature',
    '  signatureStatus = [string]$signature.Status',
    '  signerName = if ($signer) { [string]$signer.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) } else { \'\' }',
    '  signerSubject = if ($signer) { [string]$signer.SubjectName.Decode([System.Security.Cryptography.X509Certificates.X500DistinguishedNameFlags]::UseCommas) } else { \'\' }',
    '} | ConvertTo-Json -Compress',
  ].join('\n')
}

function inspectionText(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' && value.length <= 4096 ? value : ''
}

/** 核对结果不对时抛出的原话会进运行日志，界面上只按它归类（claude-desktop-install-failure.ts）。 */
export function validateClaudeDesktopPackageInspection(
  output: string,
  architecture: 'x64' | 'arm64',
  // 只给测试换：Anthropic 的发布者全文仓库里没有，测试拿已知的微软发布者走通过的那条路。
  publisherId: string = claudeDesktopPublisherId,
): { version: string } {
  let record: Record<string, unknown>
  try {
    const value = JSON.parse(output.trim().replace(/^﻿/, '')) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    record = value as Record<string, unknown>
  } catch {
    throw new Error('核对 Claude 官网安装包的结果读不出来')
  }
  const name = inspectionText(record, 'name')
  if (name !== 'Claude') throw new Error(`Claude 官网的安装包身份不对（包名是 ${name || '空'}）`)
  const packageArchitecture = inspectionText(record, 'architecture').toLowerCase()
  if (packageArchitecture !== architecture) {
    throw new Error(`Claude 官网的安装包身份不对（架构是 ${packageArchitecture || '空'}，本机是 ${architecture}）`)
  }
  const publisher = inspectionText(record, 'publisher')
  if (!publisher || windowsPackagePublisherId(publisher) !== publisherId) {
    throw new Error('Claude 官网的安装包发布者不是 Anthropic')
  }
  const publisherCanonical = inspectionText(record, 'publisherCanonical')
  if (
    record.hasSignature !== true
    || inspectionText(record, 'signatureStatus') !== 'Valid'
    || inspectionText(record, 'signerName') !== claudeDesktopSignerName
    || !publisherCanonical
    || inspectionText(record, 'signerSubject') !== publisherCanonical
  ) {
    throw new Error('Claude 官网的安装包缺少有效的 Anthropic 签名')
  }
  const version = inspectionText(record, 'version')
  if (!/^\d{1,5}(?:\.\d{1,5}){3}$/.test(version) || version.split('.').some((part) => Number(part) > 65535)) {
    throw new Error('Claude 官网的安装包版本号无效')
  }
  return { version }
}

export interface ClaudeDesktopMsixProgress {
  phase: 'downloading' | 'checking' | 'installing'
  message: string
  percent: number | null
}

/** 下载这一路给用户看的那一行（照界面文字定稿）。 */
export function describeClaudeDesktopMsixDownload(
  wingetTried: boolean,
  progress: { percent: number; resuming?: boolean },
): string {
  if (progress.resuming) return `网络断了一下，正在接着从 Claude 官网下载离线安装包（已下 ${progress.percent}%）`
  return `${wingetTried ? '系统自带的安装组件这次没装上，' : ''}正在从 Claude 官网下载离线安装包（${progress.percent}%）`
}

export interface ClaudeDesktopMsixInstallOptions {
  architecture: NodeJS.Architecture
  /** 系统自带的安装组件先试过、没装上：进度提示开头要交代一句。 */
  wingetTried: boolean
  /** 必填：生产传接好系统代理与加速线路的 fetch（主进程全局 fetch 不读系统代理）。 */
  fetch: typeof fetch
  windowsExecutionMode?: WindowsCliExecutionMode
  runCommand?: typeof runCommand
  env?: NodeJS.ProcessEnv
  onProgress?: (event: ClaudeDesktopMsixProgress) => void
  /** 下载和核对安装包时客户点了取消。交给 Windows 装的那一步不看它，见 onInstallStarting。 */
  signal?: AbortSignal
  /**
   * 下好、核过的安装包马上交给 Windows 装，之后 signal 不再起作用：调用方在这里停止接受取消，
   * 免得界面说「已取消」而 Windows 照样装完。在最后一次检查 signal 之后同步调用，中间没有空档。
   */
  onInstallStarting?: () => void
  /** Test seams; production uses the fixed Windows resolvers and the shared MSIX installer. */
  platform?: NodeJS.Platform
  resolveMachinePaths?: () => WindowsMachinePaths
  resolvePowerShellExecutable?: () => string
  createTemporaryDirectory?: (mode: WindowsCliExecutionMode) => Promise<string>
  installPackage?: typeof addWindowsDesktopAppxPackage
  resumeOptions?: Pick<ResumableDownloadOptions, 'wait' | 'idleTimeoutMs'>
  /** Test seam for validateClaudeDesktopPackageInspection's publisher ID. */
  packagePublisherId?: string
}

function reportProgress(options: ClaudeDesktopMsixInstallOptions, event: ClaudeDesktopMsixProgress): void {
  try { options.onProgress?.(event) } catch { /* A disconnected observer cannot alter the installation. */ }
}

async function fetchClaudeDesktopPackage(
  url: string,
  followRedirects: boolean,
  headers: Record<string, string>,
  signal: AbortSignal,
  fetchImplementation: typeof fetch,
): Promise<{ response: Response; url: string }> {
  let current = validateClaudeDesktopDownloadUrl(url)
  const visited = new Set<string>()
  for (let hop = 0; hop <= maximumClaudeDesktopRedirects; hop += 1) {
    if (visited.has(current.href)) throw new Error('Claude 官网下载出现了循环重定向')
    visited.add(current.href)
    const response = await fetchImplementation(current.href, {
      headers: { Accept: 'application/vnd.ms-appx, application/octet-stream, */*', ...headers },
      redirect: 'manual',
      credentials: 'omit',
      signal,
    })
    if (response.url && response.url !== current.href) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error('Claude 官网下载绕过了受限的重定向规则')
    }
    if (!claudeDesktopRedirectStatuses.has(response.status)) return { response, url: current.href }
    await response.body?.cancel().catch(() => undefined)
    // 接着下时只找上一次落到的那个文件：入口这时可能已经指向了新版本，拼起来就是两个包。
    if (!followRedirects) return { response, url: current.href }
    if (hop === maximumClaudeDesktopRedirects) throw new Error('Claude 官网下载重定向次数过多')
    const location = response.headers.get('location')
    if (!location) throw new Error('Claude 官网下载重定向缺少目标地址')
    current = validateClaudeDesktopDownloadUrl(new URL(location, current).href)
  }
  throw new Error('Claude 官网下载重定向次数过多')
}

async function downloadClaudeDesktopPackage(
  architecture: 'x64' | 'arm64',
  destination: string,
  options: ClaudeDesktopMsixInstallOptions,
): Promise<{ size: number; sha256Base64: string }> {
  let resolvedUrl: string | null = null
  let total = 0
  let lastPercent = -1
  const percentOf = (transferred: number) => (total > 0 ? Math.min(100, Math.floor((transferred / total) * 100)) : 0)
  try {
    const download = await downloadWithResume({
      targetPath: destination,
      fileMode: 0o600,
      maximumBytes: maximumClaudeDesktopPackageBytes,
      oversizeMessage: 'Claude 官网返回的数据超过声明的安装包大小',
      signal: options.signal,
      responseTimeoutMs: 20_000,
      idleTimeoutMs: 45_000,
      ...options.resumeOptions,
      request: async (headers, signal) => {
        const result = await fetchClaudeDesktopPackage(
          resolvedUrl ?? claudeDesktopMsixEntryUrl(architecture),
          resolvedUrl === null,
          headers,
          signal,
          options.fetch,
        )
        resolvedUrl = result.url
        return result.response
      },
      acceptResponse: (response) => {
        if (response.status !== 200) throw new Error(`Claude 官网返回 HTTP ${response.status}`)
        const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
        // 官网没承诺固定的 Content-Type；网页、JSON、XML 多半是拦截页或报错，不是安装包。
        if (/^text\/|json|xml|html/.test(contentType)) {
          throw new Error(`Claude 官网返回的不是 MSIX 文件（Content-Type: ${contentType}）`)
        }
        const declared = Number(response.headers.get('content-length'))
        if (!Number.isSafeInteger(declared) || declared < minimumClaudeDesktopPackageBytes) {
          throw new Error('Claude 官网返回的安装包大小无效')
        }
        if (declared > maximumClaudeDesktopPackageBytes) throw new Error('Claude 官网返回的安装包超过 1.5 GB 安全上限')
        if (!response.body) throw new Error('Claude 官网没有返回安装包内容')
        total = declared
        return declared
      },
      onProgress: (transferred) => {
        const percent = percentOf(transferred)
        if (percent === lastPercent) return
        lastPercent = percent
        reportProgress(options, {
          phase: 'downloading',
          percent,
          message: describeClaudeDesktopMsixDownload(options.wingetTried, { percent }),
        })
      },
      onResume: (transferred) => {
        const percent = percentOf(transferred)
        reportProgress(options, {
          phase: 'downloading',
          percent,
          message: describeClaudeDesktopMsixDownload(options.wingetTried, { percent, resuming: true }),
        })
      },
    })
    if (download.size !== total) throw new Error(`Claude 官网的安装包下载不完整：应为 ${total} 字节，实际 ${download.size} 字节`)
    return { size: download.size, sha256Base64: download.sha256.toString('base64') }
  } catch (error) {
    await fs.promises.rm(destination, { force: true }).catch(() => undefined)
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('安装已取消。')
    if (error instanceof DownloadStalledError || (error instanceof Error && error.name === 'AbortError')) {
      throw new Error('Claude 官网连接或下载超时')
    }
    throw error
  }
}

async function inspectClaudeDesktopPackage(
  packagePath: string,
  architecture: 'x64' | 'arm64',
  mode: WindowsCliExecutionMode,
  machinePaths: WindowsMachinePaths,
  options: ClaudeDesktopMsixInstallOptions,
): Promise<{ version: string }> {
  const execute = options.runCommand ?? runCommand
  let stdout: string
  try {
    const result = await execute({
      executable: options.resolvePowerShellExecutable?.() ?? resolveWindowsPowerShellExecutable({ machinePaths }),
      argv: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodeWindowsPowerShellCommand(buildClaudeDesktopPackageInspectionScript(packagePath))],
    }, {
      env: trustedCommandEnvironment(options.env, machinePaths, 'win32'),
      // 提权运行时安装包落在受保护的暂存目录里，这里再核一次它没有被换到用户可写的地方。
      trustedOnly: mode === 'trusted-only',
      trustedPaths: [packagePath],
      machinePaths,
      windowsHide: true,
      timeoutMs: claudeDesktopPackageInspectionTimeoutMs,
      maxOutputBytes: 64 * 1024,
      ...(options.signal ? { signal: options.signal } : {}),
    })
    stdout = cleanCommandOutput(result.stdout)
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('安装已取消。')
    const detail = error instanceof Error ? error.message : String(error)
    // PowerShell 报的原因只挂在错误上进运行日志：拼进原话会被当成别的原因来归类。
    const stderr = error instanceof CommandRunnerError ? cleanCommandOutput(error.stderr).slice(-1000) : ''
    throw Object.assign(new Error(`核对 Claude 官网安装包没有完成：${detail}`), stderr ? { stderr } : {})
  }
  return validateClaudeDesktopPackageInspection(stdout, architecture, options.packagePublisherId)
}

/**
 * 下载、核对、安装 Claude 官网的离线安装包。只负责这一路本身：装没装上由调用方
 * 照旧按本机实际注册的包来认（external-client-runtime.ts 的盘点）。
 */
export async function installClaudeDesktopFromOfficial(options: ClaudeDesktopMsixInstallOptions): Promise<{ version: string }> {
  if ((options.platform ?? process.platform) !== 'win32') throw new Error('Claude 官网离线安装包只用于 Windows')
  const architecture = options.architecture === 'x64' || options.architecture === 'arm64' ? options.architecture : null
  if (!architecture) throw new Error('当前处理器架构没有可用的官方 Windows 安装包')
  const mode = options.windowsExecutionMode ?? 'trusted-only'
  const machinePaths = (options.resolveMachinePaths ?? resolveWindowsMachinePaths)()
  options.signal?.throwIfAborted()
  reportProgress(options, {
    phase: 'downloading',
    percent: 0,
    message: describeClaudeDesktopMsixDownload(options.wingetTried, { percent: 0 }),
  })
  const directory = await (options.createTemporaryDirectory
    ? options.createTemporaryDirectory(mode)
    : mode === 'same-user'
      ? fs.promises.mkdtemp(path.join(os.tmpdir(), 'xingmang-claude-desktop-'))
      : createTrustedTemporaryDirectory('claude-desktop', {
        env: trustedCommandEnvironment(options.env, machinePaths, 'win32'),
        machinePaths,
      }))
  const packagePath = path.join(directory, `Claude-${architecture}.msix`)
  try {
    const download = await downloadClaudeDesktopPackage(architecture, packagePath, options)
    reportProgress(options, { phase: 'checking', percent: null, message: '正在检查下载下来的安装包是不是完整的官方版' })
    let inspected: { version: string }
    try {
      inspected = await inspectClaudeDesktopPackage(packagePath, architecture, mode, machinePaths, options)
    } catch (error) {
      await fs.promises.rm(packagePath, { force: true }).catch(() => undefined)
      throw error
    }
    options.signal?.throwIfAborted()
    options.onInstallStarting?.()
    reportProgress(options, { phase: 'installing', percent: null, message: `正在安装 Claude Desktop ${inspected.version}` })
    await (options.installPackage ?? addWindowsDesktopAppxPackage)(packagePath, {
      product: claudeAppxProduct,
      sha256Base64: download.sha256Base64,
      contentLength: download.size,
      onElevationRequired: () => reportProgress(options, {
        phase: 'installing',
        percent: null,
        message: '此版本需管理员权限安装服务，请在 Windows 授权窗口中允许本次安装；取消将停止安装。',
      }),
    })
    return inspected
  } finally {
    // 同 Codex 桌面端：Add-AppxPackage 装完后可能还攥着文件一会儿，放到后台删。这回没删掉的，
    // 由 install-leftovers.ts 按目录名前缀（xingmang-claude-desktop- / claude-desktop-）以后再清。
    void fs.promises.rm(directory, { recursive: true, force: true }).catch(() => undefined)
  }
}

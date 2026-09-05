import path from 'node:path'
import { parseDn } from 'builder-util-runtime'
import type { VerifyUpdateCodeSignature } from 'electron-updater'
import {
  runCommand,
  trustedCommandEnvironment,
  type CommandResult,
  type CommandSpec,
  type RunCommandOptions,
} from './command-runner'
import {
  encodeWindowsPowerShellCommand,
  resolveWindowsPowerShellExecutable,
} from './windows-elevation'

const SIGNATURE_TIMEOUT_MS = 30_000
const SIGNATURE_OUTPUT_LIMIT_BYTES = 64 * 1024
const FAILURE_PREFIX = '更新安装包 Authenticode 签名校验失败'

interface SignatureResult {
  status: string
  filePath: string
  subject: string
}

type SignatureCommandRunner = (
  spec: CommandSpec,
  options: RunCommandOptions,
) => Promise<Pick<CommandResult, 'stdout' | 'stderr'>>

export interface StrictUpdateSignatureVerifierOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  resolvePowerShellExecutable?: () => string
  runCommand?: SignatureCommandRunner
  buildTrustedEnvironment?: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv
  /** Receives a diagnostic message when verification passed via a weaker comparison; never affects the verdict. */
  warn?: (message: string) => void
}

export interface WindowsSignatureAwareUpdater {
  verifyUpdateCodeSignature: VerifyUpdateCodeSignature
}

function verificationFailure(detail: string): string {
  const normalized = detail.replace(/\s+/g, ' ').trim().slice(0, 500)
  return `${FAILURE_PREFIX}：${normalized || '未知错误'}`
}

function errorDetail(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  return String(error)
}

function signatureScript(): string {
  return [
    '$ErrorActionPreference = "Stop"',
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    'Import-Module -Name $env:XINGMANG_UPDATE_SECURITY_MODULE -Force -ErrorAction Stop',
    'Import-Module -Name $env:XINGMANG_UPDATE_UTILITY_MODULE -Force -ErrorAction Stop',
    '$signature = Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath $env:XINGMANG_UPDATE_SIGNATURE_TARGET -ErrorAction Stop',
    'if ($null -eq $signature) { throw "Get-AuthenticodeSignature did not return a result" }',
    'if ($null -eq $signature.SignerCertificate) { throw "The update installer has no signer certificate" }',
    '[pscustomobject]@{',
    '  Status = [string]$signature.Status',
    '  Path = [string]$signature.Path',
    '  Subject = [string]$signature.SignerCertificate.Subject',
    '} | Microsoft.PowerShell.Utility\\ConvertTo-Json -Compress',
  ].join('\n')
}

function parseSignatureResult(stdout: string, stderr: string): SignatureResult {
  if (Buffer.byteLength(stdout, 'utf8') > SIGNATURE_OUTPUT_LIMIT_BYTES) {
    throw new Error('签名校验结果超过大小限制')
  }
  if (stderr.trim()) throw new Error('系统 PowerShell 返回了错误输出')
  if (stdout.includes('\0')) throw new Error('签名校验结果包含无效字符')
  const text = stdout.replace(/^\uFEFF/, '').trim()
  if (!text) throw new Error('系统 PowerShell 未返回签名校验结果')

  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    throw new Error('签名校验结果不是有效 JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('签名校验结果格式错误')
  }
  const record = value as Record<string, unknown>
  const status = typeof record.Status === 'string' ? record.Status.trim() : ''
  const filePath = typeof record.Path === 'string' ? record.Path.trim() : ''
  const subject = typeof record.Subject === 'string' ? record.Subject.trim() : ''
  if (!status || !filePath || !subject) throw new Error('签名校验结果缺少状态、路径或发布者')
  return { status, filePath, subject }
}

function normalizedWindowsPath(filePath: string): string | null {
  if (!filePath || filePath.includes('\0') || !path.win32.isAbsolute(filePath)) return null
  return path.win32.normalize(filePath).toLowerCase()
}

function normalizedDn(value: string): Map<string, string> {
  const result = new Map<string, string>()
  for (const [key, entry] of parseDn(value)) {
    const normalizedKey = key.trim().toUpperCase()
    const normalizedValue = entry.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
    if (normalizedKey && normalizedValue) result.set(normalizedKey, normalizedValue)
  }
  return result
}

interface PublisherMatch {
  matched: boolean
}

function isCompletePublisherDn(value: Map<string, string>): boolean {
  return value.size >= 3 && value.has('CN') && value.has('O') && value.has('C')
}

function publisherMatches(expectedPublishers: readonly string[], subject: string): PublisherMatch {
  const actualDn = normalizedDn(subject)
  if (actualDn.size === 0) return { matched: false }

  for (const publisher of expectedPublishers) {
    const expected = publisher.trim()
    if (!expected) continue
    const expectedDn = normalizedDn(expected)
    // A bare company name (or any unparseable value) is not an identity
    // anchor: a trusted CA can issue the same CN to another subject. Require
    // a complete DN and compare both directions so extra subject attributes
    // cannot be smuggled past a partial match.
    if (!isCompletePublisherDn(expectedDn) || !isCompletePublisherDn(actualDn)) continue
    if (expectedDn.size !== actualDn.size) continue
    if ([...expectedDn].every(([key, value]) => actualDn.get(key) === value)) {
      return { matched: true }
    }
  }
  return { matched: false }
}

export function createStrictUpdateCodeSignatureVerifier(
  options: StrictUpdateSignatureVerifierOptions = {},
): VerifyUpdateCodeSignature {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const commandRunner = options.runCommand ?? runCommand
  const buildTrustedEnvironment = options.buildTrustedEnvironment ?? trustedCommandEnvironment

  return async (publisherNames, installerPath) => {
    try {
      if (platform !== 'win32') throw new Error('严格 Authenticode 校验仅支持 Windows')
      if (!Array.isArray(publisherNames) || !publisherNames.some((value) => value.trim())) {
        throw new Error('当前程序未配置可信更新发布者')
      }
      const expectedPath = normalizedWindowsPath(installerPath)
      if (!expectedPath) throw new Error('更新安装包路径不是有效的 Windows 绝对路径')

      const powershellExecutable = options.resolvePowerShellExecutable
        ? options.resolvePowerShellExecutable()
        : resolveWindowsPowerShellExecutable({ env, platform })
      if (!path.win32.isAbsolute(powershellExecutable)) {
        throw new Error('系统 PowerShell 解析结果不是绝对路径')
      }
      const modulesRoot = path.win32.join(path.win32.dirname(powershellExecutable), 'Modules')
      const commandEnv = {
        ...buildTrustedEnvironment(env),
        XINGMANG_UPDATE_SIGNATURE_TARGET: installerPath,
        XINGMANG_UPDATE_SECURITY_MODULE: path.win32.join(
          modulesRoot,
          'Microsoft.PowerShell.Security',
          'Microsoft.PowerShell.Security.psd1',
        ),
        XINGMANG_UPDATE_UTILITY_MODULE: path.win32.join(
          modulesRoot,
          'Microsoft.PowerShell.Utility',
          'Microsoft.PowerShell.Utility.psd1',
        ),
      }
      const result = await commandRunner({
        executable: powershellExecutable,
        argv: [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-InputFormat',
          'None',
          '-EncodedCommand',
          encodeWindowsPowerShellCommand(signatureScript()),
        ],
      }, {
        env: commandEnv,
        trustedOnly: true,
        timeoutMs: SIGNATURE_TIMEOUT_MS,
        maxOutputBytes: SIGNATURE_OUTPUT_LIMIT_BYTES,
        windowsHide: true,
        sensitiveValues: [installerPath],
      })

      const signature = parseSignatureResult(result.stdout, result.stderr)
      if (signature.status.toLowerCase() !== 'valid') {
        throw new Error(`签名状态不是 Valid（实际为 ${signature.status}）`)
      }
      const returnedPath = normalizedWindowsPath(signature.filePath)
      if (!returnedPath || returnedPath !== expectedPath) {
        throw new Error('签名校验返回的文件路径与更新安装包不一致')
      }
      const publisherMatch = publisherMatches(publisherNames, signature.subject)
      if (!publisherMatch.matched) {
        throw new Error('安装包签名发布者与当前程序配置不一致')
      }
      return null
    } catch (error) {
      return verificationFailure(errorDetail(error))
    }
  }
}

export function installStrictUpdateCodeSignatureVerifier(
  updater: WindowsSignatureAwareUpdater,
  options: StrictUpdateSignatureVerifierOptions = {},
): void {
  updater.verifyUpdateCodeSignature = createStrictUpdateCodeSignatureVerifier(options)
}

import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { ProviderId } from './catalog'
import { cleanCommandOutput, runCommand, trustedCommandEnvironment } from './command-runner'
import {
  managedCliRoot,
  managedNativeProviderRoot,
  managedNativeRoot,
  managedProductRoot,
} from './managed-cli-paths'
import { ensureTrustedDirectory } from './trusted-temp'
import { resolveWindowsPowerShellExecutable } from './windows-elevation'

export interface NativeCliSignature {
  status: string
  subject: string | null
}

const expectedPublisherPatterns: Partial<Record<ProviderId, RegExp>> = {
  codex: /(?:^|,\s*)(?:CN|O)="?OpenAI OpCo, LLC"?(?:,|$)/i,
  claude: /(?:^|,\s*)(?:CN|O)="?Anthropic, PBC"?(?:,|$)/i,
  grok: /(?:^|,\s*)(?:CN|O)=X\.AI LLC(?:,|$)/i,
}
const stagedCliCache = new Map<string, { size: number; mtimeMs: number; destination: string }>()

export function parseNativeCliSignature(value: unknown): NativeCliSignature {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('无法读取 CLI 数字签名')
  }
  const record = value as Record<string, unknown>
  const rawStatus = record.Status ?? record.status
  const status = typeof rawStatus === 'string'
    ? rawStatus
    : rawStatus === 0 ? 'Valid'
      : typeof rawStatus === 'number' ? `AuthenticodeStatus(${rawStatus})`
        : ''
  const subject = typeof record.Subject === 'string'
    ? record.Subject
    : typeof record.subject === 'string' ? record.subject : null
  return { status: status.trim(), subject: subject?.trim() || null }
}

export function validateNativeCliSignature(
  provider: ProviderId,
  signature: NativeCliSignature,
): void {
  const expectedPublisher = expectedPublisherPatterns[provider]
  if (!expectedPublisher) throw new Error('当前原生 CLI 不支持安全托管')
  if (signature.status.toLowerCase() !== 'valid' || !signature.subject) {
    throw new Error('原生 CLI 没有有效的 Authenticode 签名')
  }
  if (!expectedPublisher.test(signature.subject)) {
    throw new Error('原生 CLI 数字签名发布者与官方发布者不一致')
  }
}

async function inspectSignature(filePath: string): Promise<NativeCliSignature> {
  const script = [
    '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '$ErrorActionPreference = "Stop"',
    '$signature = Get-AuthenticodeSignature -LiteralPath $env:XINGMANG_NATIVE_CLI',
    '[pscustomobject]@{ Status = [string]$signature.Status; Subject = [string]$signature.SignerCertificate.Subject } | ConvertTo-Json -Compress',
  ].join('; ')
  const result = await runCommand({
    executable: resolveWindowsPowerShellExecutable(),
    argv: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
  }, {
    env: { ...trustedCommandEnvironment(), XINGMANG_NATIVE_CLI: filePath },
    trustedOnly: true,
    timeoutMs: 20_000,
    maxOutputBytes: 64 * 1024,
  })
  try {
    return parseNativeCliSignature(JSON.parse(cleanCommandOutput(result.stdout).trim()) as unknown)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('无法读取')) throw error
    throw new Error('无法解析 CLI Authenticode 签名结果')
  }
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

export interface VerifiedNativeCliFile {
  path: string
  sha256Hex: string
  size: number
}

export async function verifyOfficialNativeCliFile(
  provider: ProviderId,
  filePath: string,
): Promise<VerifiedNativeCliFile> {
  const source = requirePlainExecutable(filePath)
  const stats = fs.statSync(source)
  validateNativeCliSignature(provider, await inspectSignature(source))
  return {
    path: source,
    sha256Hex: await hashFile(source),
    size: stats.size,
  }
}

function requirePlainExecutable(filePath: string): string {
  const inputStats = fs.lstatSync(filePath)
  if (!inputStats.isFile() || inputStats.isSymbolicLink() || inputStats.nlink !== 1) {
    throw new Error('原生 CLI 必须是单链接普通文件')
  }
  const resolved = fs.realpathSync(filePath)
  const stats = fs.lstatSync(resolved)
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw new Error('原生 CLI 必须是单链接普通文件')
  }
  if (path.extname(resolved).toLowerCase() !== '.exe') {
    throw new Error('原生 CLI 不是 Windows 可执行文件')
  }
  return resolved
}

async function validateStagedFile(
  provider: ProviderId,
  filePath: string,
  expectedHash: string,
): Promise<void> {
  const actualHash = await hashFile(filePath)
  if (actualHash !== expectedHash) throw new Error('托管 CLI 复制后 SHA-256 校验失败')
  validateNativeCliSignature(provider, await inspectSignature(filePath))
}

export async function stageVerifiedNativeCli(
  provider: ProviderId,
  sourcePath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  // Returning the unverified source from a function named "stageVerified" is a
  // fail-open that reads like verification at every call site. Every caller now
  // carries an explicit win32 conjunct, so reaching here off Windows is a bug.
  if (process.platform !== 'win32') throw new Error('托管 CLI 暂存仅支持 Windows')
  const source = requirePlainExecutable(sourcePath)
  const sourceStats = fs.statSync(source)
  const cacheKey = `${provider}:${source.toLowerCase()}`
  const cached = stagedCliCache.get(cacheKey)
  if (
    cached
    && cached.size === sourceStats.size
    && cached.mtimeMs === sourceStats.mtimeMs
    && fs.existsSync(cached.destination)
  ) {
    requirePlainExecutable(cached.destination)
    return cached.destination
  }
  validateNativeCliSignature(provider, await inspectSignature(source))
  const sourceHash = await hashFile(source)

  const roots = [
    managedProductRoot(env, 'win32'),
    managedCliRoot(env, 'win32'),
    managedNativeRoot(env, 'win32'),
    managedNativeProviderRoot(provider, env, 'win32'),
  ]
  for (const root of roots) await ensureTrustedDirectory(root, { platform: 'win32', env })

  const providerRoot = roots.at(-1)!
  const baseName = path.basename(source, path.extname(source)).replace(/[^A-Za-z0-9-]/g, '') || provider
  const destination = path.join(providerRoot, `${baseName}-${sourceHash.slice(0, 24)}.exe`)
  if (fs.existsSync(destination)) {
    requirePlainExecutable(destination)
    await validateStagedFile(provider, destination, sourceHash)
    stagedCliCache.set(cacheKey, {
      size: sourceStats.size,
      mtimeMs: sourceStats.mtimeMs,
      destination,
    })
    return destination
  }

  const pending = path.join(providerRoot, `.${baseName}-${randomUUID()}.pending.exe`)
  try {
    await fs.promises.copyFile(source, pending, fs.constants.COPYFILE_EXCL)
    requirePlainExecutable(pending)
    await validateStagedFile(provider, pending, sourceHash)
    try {
      await fs.promises.rename(pending, destination)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    requirePlainExecutable(destination)
    await validateStagedFile(provider, destination, sourceHash)
  } finally {
    await fs.promises.rm(pending, { force: true }).catch(() => undefined)
  }

  // Keep the active and one fallback version. A running old executable is
  // locked by Windows, so failed cleanup is intentionally harmless.
  const stale = (await fs.promises.readdir(providerRoot))
    .filter((name) => name.startsWith(`${baseName}-`) && name.endsWith('.exe') && name !== path.basename(destination))
    .sort()
    .slice(0, -1)
  await Promise.all(stale.map((name) => fs.promises.rm(path.join(providerRoot, name), { force: true }).catch(() => undefined)))
  stagedCliCache.set(cacheKey, {
    size: sourceStats.size,
    mtimeMs: sourceStats.mtimeMs,
    destination,
  })
  return destination
}

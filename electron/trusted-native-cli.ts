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
import { authenticodeSignatureModules, buildPowerShellModuleImportStatement } from './powershell-module-imports'
import { resolveWindowsPowerShellExecutable } from './windows-elevation'

export interface NativeCliSignature {
  status: string
  subject: string | null
  /** 签发这张签名证书的 CA；缺省 = 没读到，钉了签发机构的发布者一律不认。 */
  issuer?: string | null
}

interface TrustedNativeCliPublisher {
  /** Every pattern must match the signer certificate's subject. */
  subject: readonly RegExp[]
  /** Every pattern must match the issuing CA's name; empty = issuer not pinned. */
  issuer: readonly RegExp[]
}

// One `ATTR=value` component of a name as Get-AuthenticodeSignature prints it
// (`CN=X Corp., O=X Corp., L=Bastrop, S=Texas, C=US`). Anchoring on the
// separators keeps `O=X Corp. Evil` or `OU=X Corp.` from passing as `O=X Corp.`.
function nameComponent(attribute: string, value: string): RegExp {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|,\\s*)(?:${attribute})="?${escaped}"?(?:,|$)`, 'i')
}

const expectedPublishers: Partial<Record<ProviderId, readonly TrustedNativeCliPublisher[]>> = {
  codex: [{ subject: [/(?:^|,\s*)(?:CN|O)="?OpenAI OpCo, LLC"?(?:,|$)/i], issuer: [] }],
  claude: [{ subject: [/(?:^|,\s*)(?:CN|O)="?Anthropic, PBC"?(?:,|$)/i], issuer: [] }],
  // xAI 从 Grok 1.0.54（2026-10-12）起改用 X Corp. 的证书签名，1.0.53 及更早（含推荐版本 1.0.52）
  // 还是 X.AI LLC 的，两张都要认（#1051）。两张各钉住自己的签发机构：主体名只说明「叫这个名字」，
  // 再限定是哪家 CA 发的，别家 CA 发给同名公司的证书就过不了。
  // scripts/sync-grok-cos.cjs 的 SIGNERS 是同一份名单，改一处要改两处。
  grok: [
    {
      subject: [/(?:^|,\s*)(?:CN|O)=X\.AI LLC(?:,|$)/i],
      issuer: [nameComponent('CN', 'SSL.com EV Code Signing Intermediate CA RSA R3'), nameComponent('O', 'SSL Corp')],
    },
    {
      subject: [
        nameComponent('CN', 'X Corp.'),
        nameComponent('O', 'X Corp.'),
        nameComponent('L', 'Bastrop'),
        nameComponent('S|ST', 'Texas'),
        nameComponent('C', 'US'),
      ],
      issuer: [nameComponent('CN', 'GlobalSign GCC R45 CodeSigning CA 2020'), nameComponent('O', 'GlobalSign nv-sa')],
    },
  ],
}

function matchesPublisher(publisher: TrustedNativeCliPublisher, subject: string, issuer: string | null): boolean {
  if (!publisher.subject.every((pattern) => pattern.test(subject))) return false
  if (publisher.issuer.length === 0) return true
  return issuer !== null && publisher.issuer.every((pattern) => pattern.test(issuer))
}

/**
 * 签名有效、只是签名者不在名单上。下载换个地址拿到的还是同一个文件，所以下载那边
 * 认出这一种就不再换地址重下（grok-installer.ts）。
 */
export class NativeCliPublisherMismatchError extends Error {
  constructor() {
    super('原生 CLI 数字签名发布者与官方发布者不一致')
    this.name = 'NativeCliPublisherMismatchError'
  }
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
  const issuer = typeof record.Issuer === 'string'
    ? record.Issuer
    : typeof record.issuer === 'string' ? record.issuer : null
  return { status: status.trim(), subject: subject?.trim() || null, issuer: issuer?.trim() || null }
}

export function validateNativeCliSignature(
  provider: ProviderId,
  signature: NativeCliSignature,
): void {
  const publishers = expectedPublishers[provider]
  if (!publishers) throw new Error('当前原生 CLI 不支持安全托管')
  const subject = signature.subject
  if (signature.status.toLowerCase() !== 'valid' || !subject) {
    throw new Error('原生 CLI 没有有效的 Authenticode 签名')
  }
  const issuer = signature.issuer ?? null
  if (!publishers.some((publisher) => matchesPublisher(publisher, subject, issuer))) {
    throw new NativeCliPublisherMismatchError()
  }
}

// Imported by name first: under trustedCommandEnvironment() an autoloaded
// cmdlet costs the whole System32 module scan (see
// buildPowerShellModuleImportStatement) out of the 20 s this check gets.
export const nativeCliSignatureScript = [
  '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  buildPowerShellModuleImportStatement(authenticodeSignatureModules),
  '$ErrorActionPreference = "Stop"',
  '$signature = Get-AuthenticodeSignature -LiteralPath $env:XINGMANG_NATIVE_CLI',
  '[pscustomobject]@{ Status = [string]$signature.Status; Subject = [string]$signature.SignerCertificate.Subject; Issuer = [string]$signature.SignerCertificate.Issuer } | ConvertTo-Json -Compress',
].join('; ')

export const nativeCliSignatureTimeoutMs = 20_000

async function inspectSignature(filePath: string): Promise<NativeCliSignature> {
  const result = await runCommand({
    executable: resolveWindowsPowerShellExecutable(),
    argv: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', nativeCliSignatureScript],
  }, {
    env: { ...trustedCommandEnvironment(), XINGMANG_NATIVE_CLI: filePath },
    trustedOnly: true,
    timeoutMs: nativeCliSignatureTimeoutMs,
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

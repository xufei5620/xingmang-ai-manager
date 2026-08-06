import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { readBoundedUtf8File } from './bounded-file'
import { fetchGrokStableVersion, parseGrokStableVersion, type GrokVersionFetch } from './grok-update'
import {
  managedCliRoot,
  managedNativeProviderRoot,
  managedNativeRoot,
  managedProductRoot,
} from './managed-cli-paths'
import {
  assertPlainDirectory,
  createTrustedTemporaryDirectory,
  ensureTrustedDirectory,
  type ApplyWindowsAcl,
} from './trusted-temp'
import { verifyOfficialNativeCliFile } from './trusted-native-cli'

const primaryArtifactRoot = 'https://x.ai/cli'
const fallbackArtifactRoot = 'https://storage.googleapis.com/grok-build-public-artifacts/cli'
const allowedArtifactRoots = new Set([primaryArtifactRoot, fallbackArtifactRoot])
const minimumBinaryBytes = 1024 * 1024
const maximumBinaryBytes = 512 * 1024 * 1024
const connectionTimeoutMs = 20_000
const idleTimeoutMs = 45_000
const grokTransactionPrefix = '.grok-transaction-'
const grokTransactionManifestName = 'transaction.json'
const grokManagedFileNames = ['grok.exe', 'agent.exe', 'version.json'] as const

export interface GrokDownloadProgress {
  transferred: number
  total: number
  percent: number
}

export interface DownloadedGrokBinary {
  directory: string
  binaryPath: string
  version: string
  sourceUrl: string
  size: number
  sha256Hex: string
}

export interface InstalledGrokBinary {
  version: string
  executablePath: string
  agentPath: string
  installDirectory: string
}

export interface DownloadLatestGrokOptions {
  fetchImpl?: GrokVersionFetch
  architecture?: NodeJS.Architecture
  createTemporaryDirectory?: () => Promise<string>
  verifyBinary?: typeof verifyOfficialNativeCliFile
  onProgress?: (progress: GrokDownloadProgress) => void
}

export interface InstallDownloadedGrokOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  managedRoot?: string
  /** False only for the fixed current-user ~/.grok/bin target. */
  protectInstallDirectory?: boolean
  applyWindowsAcl?: ApplyWindowsAcl
  verifyBinary?: typeof verifyOfficialNativeCliFile
  fileOperations?: GrokFileOperations
}

export interface GrokFileOperations {
  rename(source: string, destination: string): Promise<void>
  rm(target: string, options?: { force?: boolean; recursive?: boolean }): Promise<void>
}

interface GrokTransactionManifest {
  schemaVersion: 1
  targets: Array<{ fileName: typeof grokManagedFileNames[number]; hadExisting: boolean }>
}

export class GrokRollbackError extends Error {
  readonly preserveTransaction = true

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'GrokRollbackError'
  }
}

export function grokWindowsArchitecture(architecture: NodeJS.Architecture): 'x86_64' | 'aarch64' {
  if (architecture === 'x64') return 'x86_64'
  if (architecture === 'arm64') return 'aarch64'
  throw new Error(`Grok CLI 不支持当前 Windows 处理器架构 ${architecture}`)
}

export function buildGrokArtifactUrls(
  version: string,
  architecture: NodeJS.Architecture,
  preferredStableUrl = `${primaryArtifactRoot}/stable`,
): string[] {
  if (!parseGrokStableVersion(version)) throw new Error('Grok 下载版本号格式无效')
  const platform = `windows-${grokWindowsArchitecture(architecture)}`
  const preferredRoot = preferredStableUrl.startsWith(`${fallbackArtifactRoot}/`)
    ? fallbackArtifactRoot
    : primaryArtifactRoot
  const roots = [preferredRoot, ...[primaryArtifactRoot, fallbackArtifactRoot]
    .filter((root) => root !== preferredRoot)]
  return roots.flatMap((root) => {
    const artifact = `${root}/grok-${version}-${platform}`
    return [`${artifact}.exe`, artifact]
  })
}

export function validateGrokArtifactResponseUrl(responseUrl: string, expectedUrl: string): void {
  let actual: URL
  let expected: URL
  try {
    actual = new URL(responseUrl)
    expected = new URL(expectedUrl)
  } catch {
    throw new Error('Grok 二进制下载地址格式无效')
  }
  const expectedRoot = [...allowedArtifactRoots].find((root) => expected.href.startsWith(`${root}/`))
  if (
    !expectedRoot
    || actual.href !== expected.href
    || actual.protocol !== 'https:'
    || actual.port
    || actual.username
    || actual.password
    || actual.search
    || actual.hash
  ) {
    throw new Error('Grok 二进制下载发生了不受信任的重定向')
  }
}

function compactError(error: unknown): string {
  const candidate = error as { name?: unknown; message?: unknown }
  if (candidate?.name === 'AbortError') return '连接或下载超时'
  const message = typeof candidate?.message === 'string' ? candidate.message : String(error)
  return message.replace(/\s+/g, ' ').trim().slice(0, 300) || '下载失败'
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

function assertPlainSingleLinkFile(filePath: string): void {
  const stats = fs.lstatSync(filePath)
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw new Error('Grok CLI 目标不是单链接普通文件')
  }
  if (path.resolve(fs.realpathSync(filePath)) !== path.resolve(filePath)) {
    throw new Error('Grok CLI 目标经过了符号链接或目录联接')
  }
}

async function downloadArtifact(
  url: string,
  destination: string,
  fetchImpl: GrokVersionFetch,
  onProgress: (progress: GrokDownloadProgress) => void,
): Promise<{ size: number; sha256Hex: string }> {
  const controller = new AbortController()
  const connectionTimeout = setTimeout(() => controller.abort(), connectionTimeoutMs)
  connectionTimeout.unref?.()
  let file: fs.promises.FileHandle | null = null
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/octet-stream' },
      redirect: 'error',
      signal: controller.signal,
    })
    clearTimeout(connectionTimeout)
    if (!response.ok) throw new Error(`返回 HTTP ${response.status}`)
    validateGrokArtifactResponseUrl(response.url, url)
    const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? ''
    if (!['application/octet-stream', 'binary/octet-stream', 'application/x-msdownload'].includes(contentType)) {
      throw new Error(`返回的不是 Windows 可执行文件（Content-Type: ${contentType || '缺失'}）`)
    }
    const declaredLength = response.headers.get('content-length')
    if (!declaredLength || !/^\d+$/.test(declaredLength)) {
      throw new Error('响应缺少有效的 Content-Length')
    }
    const total = Number(declaredLength)
    if (!Number.isSafeInteger(total) || total < minimumBinaryBytes || total > maximumBinaryBytes) {
      throw new Error('Grok 二进制文件大小超出 1 MiB 至 512 MiB 安全范围')
    }
    if (!response.body) throw new Error('没有响应正文')

    file = await fs.promises.open(destination, 'wx', 0o600)
    const reader = response.body.getReader()
    const hash = createHash('sha256')
    let transferred = 0
    let lastPercent = -1
    while (true) {
      const idleTimeout = setTimeout(() => controller.abort(), idleTimeoutMs)
      idleTimeout.unref?.()
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await reader.read()
      } finally {
        clearTimeout(idleTimeout)
      }
      if (chunk.done) break
      if (!chunk.value?.byteLength) continue
      transferred += chunk.value.byteLength
      if (transferred > total || transferred > maximumBinaryBytes) {
        throw new Error('下载数据超过声明的文件大小')
      }
      hash.update(chunk.value)
      await file.write(chunk.value)
      const percent = Math.min(100, Math.floor((transferred / total) * 100))
      if (percent !== lastPercent) {
        lastPercent = percent
        onProgress({ transferred, total, percent })
      }
    }
    if (transferred !== total) {
      throw new Error(`下载不完整：应为 ${total} 字节，实际 ${transferred} 字节`)
    }
    await file.sync()
    await file.close()
    file = null
    return { size: transferred, sha256Hex: hash.digest('hex') }
  } catch (error) {
    await file?.close().catch(() => undefined)
    file = null
    await fs.promises.rm(destination, { force: true }).catch(() => undefined)
    throw error
  } finally {
    clearTimeout(connectionTimeout)
    await file?.close().catch(() => undefined)
  }
}

export async function downloadLatestGrokBinary(
  options: DownloadLatestGrokOptions = {},
): Promise<DownloadedGrokBinary> {
  if (process.platform !== 'win32' && options.architecture === undefined) {
    throw new Error('Grok CLI 一键安装目前仅支持 Windows')
  }
  const fetchImpl = options.fetchImpl ?? fetch
  const architecture = options.architecture ?? process.arch
  const verifyBinary = options.verifyBinary ?? verifyOfficialNativeCliFile
  const stable = await fetchGrokStableVersion({ fetchImpl })
  const directory = await (options.createTemporaryDirectory
    ? options.createTemporaryDirectory()
    : createTrustedTemporaryDirectory('grok-binary'))
  const binaryPath = path.join(directory, 'grok-download.exe')
  const errors: string[] = []
  try {
    for (const url of buildGrokArtifactUrls(stable.version, architecture, stable.sourceUrl)) {
      try {
        const downloaded = await downloadArtifact(
          url,
          binaryPath,
          fetchImpl,
          options.onProgress ?? (() => undefined),
        )
        const verified = await verifyBinary('grok', binaryPath)
        if (verified.size !== downloaded.size || verified.sha256Hex !== downloaded.sha256Hex) {
          throw new Error('Grok 二进制在签名校验期间发生变化')
        }
        return {
          directory,
          binaryPath,
          version: stable.version,
          sourceUrl: url,
          size: downloaded.size,
          sha256Hex: downloaded.sha256Hex,
        }
      } catch (error) {
        errors.push(`${new URL(url).hostname}：${compactError(error)}`)
        await fs.promises.rm(binaryPath, { force: true }).catch(() => undefined)
      }
    }
    throw new Error(`Grok 官方二进制下载或签名校验失败：${errors.join('；')}`)
  } catch (error) {
    await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

interface StagedManagedReplacement {
  destination: string
  pending: string
  backup: string
  hadExisting: boolean
  backedUp: boolean
  installed: boolean
  validateInstalled: () => Promise<void>
}

function transactionFile(
  transactionDirectory: string,
  prefix: 'pending' | 'previous',
  destination: string,
): string {
  return path.join(transactionDirectory, `${prefix}-${path.basename(destination)}`)
}

function parseGrokTransactionManifest(input: string): GrokTransactionManifest {
  if (!input.trim() || Buffer.byteLength(input, 'utf8') > 16 * 1024) {
    throw new Error('Grok CLI 安装事务清单大小无效')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(input) as unknown
  } catch {
    throw new Error('Grok CLI 安装事务清单不是有效 JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Grok CLI 安装事务清单结构无效')
  }
  const record = parsed as Record<string, unknown>
  if (record.schemaVersion !== 1 || !Array.isArray(record.targets)) {
    throw new Error('Grok CLI 安装事务清单版本无效')
  }
  const targets = record.targets.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const target = entry as Record<string, unknown>
    if (
      typeof target.fileName !== 'string'
      || !grokManagedFileNames.includes(target.fileName as typeof grokManagedFileNames[number])
      || typeof target.hadExisting !== 'boolean'
    ) return []
    return [{
      fileName: target.fileName as typeof grokManagedFileNames[number],
      hadExisting: target.hadExisting,
    }]
  })
  if (
    targets.length !== grokManagedFileNames.length
    || new Set(targets.map((target) => target.fileName)).size !== grokManagedFileNames.length
  ) {
    throw new Error('Grok CLI 安装事务清单目标无效')
  }
  return { schemaVersion: 1, targets }
}

async function writeGrokTransactionManifest(
  transactionDirectory: string,
  replacements: StagedManagedReplacement[],
): Promise<void> {
  const manifestPath = path.join(transactionDirectory, grokTransactionManifestName)
  const targets = replacements.map((replacement) => ({
    fileName: path.basename(replacement.destination) as typeof grokManagedFileNames[number],
    hadExisting: replacement.hadExisting,
  }))
  const manifest = parseGrokTransactionManifest(JSON.stringify({ schemaVersion: 1, targets }))
  const handle = await fs.promises.open(manifestPath, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  assertPlainSingleLinkFile(manifestPath)
}

export async function recoverInterruptedGrokInstallation(
  installDirectory: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (!fs.existsSync(installDirectory)) return false
  assertPlainDirectory(installDirectory, platform)
  const entries = await fs.promises.readdir(installDirectory, { withFileTypes: true })
  const recoverable: Array<{ directory: string; manifest: GrokTransactionManifest }> = []
  for (const entry of entries) {
    if (!entry.name.startsWith(grokTransactionPrefix)) continue
    const transactionDirectory = path.join(installDirectory, entry.name)
    assertPlainDirectory(transactionDirectory, platform)
    const manifestPath = path.join(transactionDirectory, grokTransactionManifestName)
    if (!fs.existsSync(manifestPath)) {
      await fs.promises.rm(transactionDirectory, { recursive: true, force: true })
      continue
    }
    assertPlainSingleLinkFile(manifestPath)
    recoverable.push({
      directory: transactionDirectory,
      manifest: parseGrokTransactionManifest(await readBoundedUtf8File(
        manifestPath,
        16 * 1024,
        'Grok CLI 安装事务清单',
      )),
    })
  }
  if (recoverable.length > 1) {
    throw new Error('检测到多个未完成的 Grok CLI 安装事务，无法安全判断应恢复的版本')
  }
  const interrupted = recoverable[0]
  if (!interrupted) return false

  for (const target of [...interrupted.manifest.targets].reverse()) {
    const destination = path.join(installDirectory, target.fileName)
    const previous = transactionFile(interrupted.directory, 'previous', destination)
    if (target.hadExisting) {
      if (fs.existsSync(previous)) {
        assertPlainSingleLinkFile(previous)
        if (fs.existsSync(destination)) {
          assertPlainSingleLinkFile(destination)
          await fs.promises.rm(destination, { force: false })
        }
        await fs.promises.rename(previous, destination)
      } else {
        if (!fs.existsSync(destination)) {
          throw new Error(`Grok CLI 安装恢复失败：旧的 ${target.fileName} 已丢失`)
        }
        assertPlainSingleLinkFile(destination)
      }
    } else if (fs.existsSync(destination)) {
      assertPlainSingleLinkFile(destination)
      await fs.promises.rm(destination, { force: false })
    }
  }
  await fs.promises.rm(interrupted.directory, { recursive: true, force: true })
  return true
}

async function syncFile(filePath: string): Promise<void> {
  const handle = await fs.promises.open(filePath, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function validateManagedExecutable(
  filePath: string,
  expectedHash: string,
  verifyBinary: typeof verifyOfficialNativeCliFile,
): Promise<void> {
  assertPlainSingleLinkFile(filePath)
  const verification = await verifyBinary('grok', filePath)
  if (verification.sha256Hex !== expectedHash) {
    throw new Error('Grok CLI 托管副本 SHA-256 校验失败')
  }
}

async function stageManagedExecutable(
  source: string,
  destination: string,
  expectedHash: string,
  verifyBinary: typeof verifyOfficialNativeCliFile,
  transactionDirectory: string,
): Promise<StagedManagedReplacement> {
  const pending = transactionFile(transactionDirectory, 'pending', destination)
  const backup = transactionFile(transactionDirectory, 'previous', destination)
  try {
    await fs.promises.copyFile(source, pending, fs.constants.COPYFILE_EXCL)
    await syncFile(pending)
    await validateManagedExecutable(pending, expectedHash, verifyBinary)
    return {
      destination,
      pending,
      backup,
      hadExisting: false,
      backedUp: false,
      installed: false,
      validateInstalled: () => validateManagedExecutable(destination, expectedHash, verifyBinary),
    }
  } catch (error) {
    await fs.promises.rm(pending, { force: true }).catch(() => undefined)
    throw error
  }
}

async function stageManagedMetadata(
  destination: string,
  content: string,
  transactionDirectory: string,
): Promise<StagedManagedReplacement> {
  const pending = transactionFile(transactionDirectory, 'pending', destination)
  const backup = transactionFile(transactionDirectory, 'previous', destination)
  try {
    const handle = await fs.promises.open(pending, 'wx', 0o600)
    try {
      await handle.writeFile(content, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    assertPlainSingleLinkFile(pending)
    return {
      destination,
      pending,
      backup,
      hadExisting: false,
      backedUp: false,
      installed: false,
      validateInstalled: async () => {
        assertPlainSingleLinkFile(destination)
        if (await fs.promises.readFile(destination, 'utf8') !== content) {
          throw new Error('Grok CLI 版本元数据安装后校验失败')
        }
      },
    }
  } catch (error) {
    await fs.promises.rm(pending, { force: true }).catch(() => undefined)
    throw error
  }
}

async function commitManagedReplacements(
  replacements: StagedManagedReplacement[],
  transactionDirectory: string,
  operations: GrokFileOperations,
): Promise<void> {
  let preserveTransaction = false
  try {
    // Validate every existing target before moving any file. The directory ACL
    // is already protected, so all three targets form one application-level
    // transaction from this point onward.
    for (const replacement of replacements) {
      replacement.hadExisting = fs.existsSync(replacement.destination)
      if (replacement.hadExisting) assertPlainSingleLinkFile(replacement.destination)
    }
    await writeGrokTransactionManifest(transactionDirectory, replacements)
    for (const replacement of replacements) {
      if (!replacement.hadExisting) continue
      await operations.rename(replacement.destination, replacement.backup)
      replacement.backedUp = true
    }
    for (const replacement of replacements) {
      await operations.rename(replacement.pending, replacement.destination)
      replacement.installed = true
    }
    for (const replacement of replacements) await replacement.validateInstalled()
  } catch (error) {
    const rollbackErrors: string[] = []
    for (const replacement of [...replacements].reverse()) {
      if (replacement.installed && fs.existsSync(replacement.destination)) {
        try {
          await operations.rm(replacement.destination, { force: true })
        } catch (rollbackError) {
          rollbackErrors.push(`删除 ${path.basename(replacement.destination)} 失败：${String(rollbackError)}`)
        }
      }
      if (replacement.backedUp && fs.existsSync(replacement.backup)) {
        try {
          await operations.rename(replacement.backup, replacement.destination)
        } catch (rollbackError) {
          rollbackErrors.push(`恢复 ${path.basename(replacement.destination)} 失败：${String(rollbackError)}`)
        }
      }
    }
    if (rollbackErrors.length > 0) {
      preserveTransaction = true
      throw new GrokRollbackError(
        `Grok CLI 安装失败且旧版本回滚不完整：${rollbackErrors.join('；')}`,
        { cause: error },
      )
    }
    throw error
  } finally {
    if (!preserveTransaction) {
      await fs.promises.rm(transactionDirectory, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

export async function installDownloadedGrokBinary(
  download: DownloadedGrokBinary,
  options: InstallDownloadedGrokOptions = {},
): Promise<InstalledGrokBinary> {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') throw new Error('Grok CLI 一键安装目前仅支持 Windows')
  if (!parseGrokStableVersion(download.version)) throw new Error('Grok 安装版本号格式无效')
  assertPlainSingleLinkFile(download.binaryPath)
  const sourceHash = await sha256File(download.binaryPath)
  if (sourceHash !== download.sha256Hex) throw new Error('Grok 下载文件在安装前发生变化')
  const verifyBinary = options.verifyBinary ?? verifyOfficialNativeCliFile
  const sourceVerification = await verifyBinary('grok', download.binaryPath)
  if (sourceVerification.sha256Hex !== download.sha256Hex || sourceVerification.size !== download.size) {
    throw new Error('Grok 下载文件在安装前签名或校验和不一致')
  }

  const env = options.env ?? process.env
  const installDirectory = options.managedRoot ?? managedNativeProviderRoot('grok', env, platform)
  const protectInstallDirectory = options.protectInstallDirectory ?? true
  if (protectInstallDirectory) {
    const roots = options.managedRoot
      ? [installDirectory]
      : [
          managedProductRoot(env, platform),
          managedCliRoot(env, platform),
          managedNativeRoot(env, platform),
          installDirectory,
        ]
    for (const root of roots) {
      await ensureTrustedDirectory(root, {
        platform,
        env,
        applyWindowsAcl: options.applyWindowsAcl,
      })
    }
  } else {
    if (!options.managedRoot) throw new Error('普通用户 Grok 安装必须指定用户级目录')
    await fs.promises.mkdir(installDirectory, { recursive: true, mode: 0o700 })
    assertPlainDirectory(installDirectory, platform)
  }
  await recoverInterruptedGrokInstallation(installDirectory, platform)

  const transactionDirectory = path.join(installDirectory, `${grokTransactionPrefix}${randomUUID()}`)
  await fs.promises.mkdir(transactionDirectory, { recursive: false, mode: 0o700 })
  assertPlainDirectory(transactionDirectory, platform)

  const executablePath = path.join(installDirectory, 'grok.exe')
  const agentPath = path.join(installDirectory, 'agent.exe')
  const metadataPath = path.join(installDirectory, 'version.json')
  const content = `${JSON.stringify({
    version: download.version,
    stable_version: download.version,
    checked_at: new Date().toISOString(),
  }, null, 2)}\n`

  const replacements: StagedManagedReplacement[] = []
  let preserveTransaction = false
  try {
    replacements.push(await stageManagedExecutable(
      download.binaryPath,
      agentPath,
      download.sha256Hex,
      verifyBinary,
      transactionDirectory,
    ))
    replacements.push(await stageManagedExecutable(
      download.binaryPath,
      executablePath,
      download.sha256Hex,
      verifyBinary,
      transactionDirectory,
    ))
    replacements.push(await stageManagedMetadata(metadataPath, content, transactionDirectory))
    await commitManagedReplacements(
      replacements,
      transactionDirectory,
      options.fileOperations ?? fs.promises,
    )
  } catch (error) {
    preserveTransaction = error instanceof GrokRollbackError && error.preserveTransaction
    throw error
  } finally {
    if (!preserveTransaction) {
      await fs.promises.rm(transactionDirectory, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  return { version: download.version, executablePath, agentPath, installDirectory }
}

export async function cleanupDownloadedGrokBinary(download: DownloadedGrokBinary): Promise<void> {
  await fs.promises.rm(download.directory, { recursive: true, force: true }).catch(() => undefined)
}

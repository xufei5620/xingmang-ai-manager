import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readAntigravityCliBucketRelease, maximumAntigravityCliArtifactBytes, minimumAntigravityCliArtifactBytes } from './antigravity-cli-bucket'
import { extractAntigravityCliArchive, verifyDarwinAntigravityCli, type AntigravityCliDarwinProcess } from './antigravity-cli-macos'
import {
  antigravityCliArtifactOrigin,
  antigravityCliManifestOrigin,
  buildAntigravityCliManifestUrl,
  maximumAntigravityCliManifestBytes,
  parseAntigravityCliManifest,
  resolveAntigravityCliPlatform,
  type AntigravityCliPlatform,
} from './antigravity-cli-release'
import { readBoundedResponseText } from './bounded-response'
import { commandEnvironment, runCommand, type CommandResult } from './command-runner'
import { downloadDesktopBucketPackage } from './desktop-package-bucket'
import { downloadWithResume, DownloadStalledError } from './download-retry'
import { DarwinCliProvenanceError } from './macos-code-signing'
import { sameLocalPathIdentity } from './path-identity'
import { assertNoReparseComponents, ensureSafeDataDirectory, renameWithTransientRetry } from './safe-local-data'
import { verifyOfficialNativeCliFile, NativeCliPublisherMismatchError } from './trusted-native-cli'
import { createTrustedTemporaryDirectory } from './trusted-temp'
import { ensureDirectoryOnWindowsUserPath, type UserPathOutcome } from './windows-cli-shell-access'
import type { WindowsCliExecutionMode } from './windows-elevation'

/**
 * 一键装 agy（Antigravity 命令行）。装到谷歌安装脚本放的同一个位置：Windows 是 %LOCALAPPDATA%\agy\bin\agy.exe，
 * Mac 是 ~/.local/bin/agy，agy 自己在后台更新时找的就是这里。不跑 `agy install`：实测它把目录插到 PATH 最前面，
 * 还会清理启动文件里的 alias（方案第二节）。Windows 把目录加在用户 PATH 最后（已有就不加）；Mac 的 PATH 由
 * antigravity-macos-environment.ts 写进启动文件的那一段负责。
 *
 * 先从星芒存储桶下（antigravity-cli-bucket.ts），没走通再问谷歌的清单、从谷歌下；只有谷歌那一路借加速线路。
 *
 * Trust: every download is bound to a digest before anything else looks at it (the bucket's
 * SHA-256, or the SHA-512 in Google's manifest), and nothing is put where a terminal will run it
 * until Google's code signature has been checked on the exact bytes: the Windows Authenticode
 * publisher pinned in trusted-native-cli.ts, or, on a Mac, the Developer ID requirement in
 * antigravity-cli-macos.ts. The download and check happen in the trusted installer cache; the
 * checked file is copied next to its destination, compared by SHA-256 and renamed into place, so
 * the destination only ever holds a complete verified build. The destination folder may not pass
 * through a link or junction (I8). On Windows the folder is the user's own, so a session running
 * as administrator (trusted-only) refuses to write there at all: an elevated write into a
 * user-writable folder is exactly what that mode exists to avoid.
 */

const manifestTimeoutMs = 15_000
const connectionTimeoutMs = 20_000
const idleTimeoutMs = 45_000
const allowedArtifactHost = new URL(antigravityCliArtifactOrigin).host
const allowedManifestHost = new URL(antigravityCliManifestOrigin).host

export interface AntigravityCliInstallTarget {
  directory: string
  executablePath: string
}

export interface AntigravityCliDownloadProgress {
  transferred: number
  total: number
  percent: number
}

/** 管理员身份打开的星芒不往用户自己的文件夹里放程序（见文件头）。 */
export class AntigravityCliElevatedSessionError extends Error {
  constructor() {
    super('星芒正以管理员身份运行，无法安装、设置或打开 Antigravity。请以普通方式重新打开星芒。')
    this.name = 'AntigravityCliElevatedSessionError'
  }
}

/**
 * 从谷歌原址下回来的也不是谷歌签的。还是 NativeCliPublisherMismatchError（调用方和测试按它认「别人的程序」），
 * 只是换成客户看得懂的那句：共用的那句里有「原生 CLI」这类技术词。
 */
export class AntigravityCliNotOfficialError extends NativeCliPublisherMismatchError {
  constructor() {
    super()
    this.name = 'AntigravityCliNotOfficialError'
    this.message = '下载的 Antigravity 命令行不是 Google 官方签名版本，已删除，未进行安装'
  }
}

/** Windows 上 agy.exe 正开着，替换不了。 */
export class AntigravityCliInUseError extends Error {
  constructor() {
    super('Antigravity 命令行正在运行，请先关闭后再安装')
    this.name = 'AntigravityCliInUseError'
  }
}

export interface InstallAntigravityCliOptions {
  /** 跟 resolveWindowsCliExecutionMode 的结论走；Mac 上恒为 same-user。 */
  executionMode: WindowsCliExecutionMode
  platform?: NodeJS.Platform
  architecture?: NodeJS.Architecture
  env?: NodeJS.ProcessEnv
  homeDirectory?: string
  /** 测试用：直接给出装到哪里。 */
  target?: AntigravityCliInstallTarget
  fetchImpl?: typeof fetch
  signal?: AbortSignal
  onProgress?(progress: AntigravityCliDownloadProgress): void
  /** 有这一项才先试存储桶；没走通时把原因交给它（只进运行日志，不上屏）。 */
  bucket?: { onFallback?(reason: string): void }
  /** 只包谷歌那一路（加速线路）。 */
  withVendorDownloadRoute?<T>(operation: () => Promise<T>): Promise<T>
  createTemporaryDirectory?(): Promise<string>
  verifyWindowsExecutable?(filePath: string): Promise<{ size: number; sha256Hex: string }>
  runDarwinProcess?(plan: AntigravityCliDarwinProcess): Promise<CommandResult>
  ensureWindowsUserPath?(directory: string): Promise<UserPathOutcome>
}

export interface InstalledAntigravityCli {
  version: string
  executablePath: string
  source: 'bucket' | 'google'
  /** 只有 Windows 有：用户 PATH 这次加上了，还是本来就有。 */
  userPath?: UserPathOutcome
}

interface StagedAntigravityCli {
  executablePath: string
  sha256Hex: string
  version: string
  source: InstalledAntigravityCli['source']
}

interface InstallContext {
  platform: AntigravityCliPlatform
  architecture: 'x64' | 'arm64'
  directory: string
  fetchImpl: typeof fetch
  options: InstallAntigravityCliOptions
}

/** agy 装在哪里；不是 Windows、Mac 就是 null。 */
export function resolveAntigravityCliInstallTarget(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  homeDirectory: string,
): AntigravityCliInstallTarget | null {
  if (platform === 'win32') {
    const fromEnvironment = env.LOCALAPPDATA?.trim()
    const localAppData = fromEnvironment && path.win32.isAbsolute(fromEnvironment)
      ? fromEnvironment
      : path.win32.join(homeDirectory, 'AppData', 'Local')
    const directory = path.win32.join(localAppData, 'agy', 'bin')
    return { directory, executablePath: path.win32.join(directory, 'agy.exe') }
  }
  if (platform === 'darwin') {
    const directory = path.posix.join(homeDirectory, '.local', 'bin')
    return { directory, executablePath: path.posix.join(directory, 'agy') }
  }
  return null
}

const downloadTimeoutText = '连接或下载超时'

function compactError(error: unknown): string {
  const candidate = error as { name?: unknown; message?: unknown }
  if (candidate?.name === 'AbortError' || candidate?.name === 'TimeoutError' || error instanceof DownloadStalledError) return downloadTimeoutText
  const message = typeof candidate?.message === 'string' ? candidate.message : String(error)
  return message.replace(/\s+/g, ' ').trim().slice(0, 300) || '下载失败'
}

async function hashFile(filePath: string, algorithm: 'sha256' | 'sha512'): Promise<string> {
  const hash = createHash(algorithm)
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

function assertPlainSingleLinkFile(filePath: string, label: string): void {
  const stats = fs.lstatSync(filePath)
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || !sameLocalPathIdentity(fs.realpathSync(filePath), filePath)) {
    throw new Error(`${label}不是单链接普通文件`)
  }
}

function defaultRunDarwinProcess(plan: AntigravityCliDarwinProcess): Promise<CommandResult> {
  return runCommand({ executable: plan.executable, argv: plan.argv }, { env: commandEnvironment(), trustedOnly: false, timeoutMs: plan.timeoutMs, maxOutputBytes: 1024 * 1024 })
}

/** 下回来的文件按平台核谷歌的签名，返回核过的那一份程序。 */
async function verifyDownloaded(context: InstallContext, downloadedPath: string, version: string, source: StagedAntigravityCli['source']): Promise<StagedAntigravityCli> {
  const { options } = context
  if (context.platform.startsWith('windows_')) {
    const verify = options.verifyWindowsExecutable ?? ((filePath: string) => verifyOfficialNativeCliFile('antigravity', filePath))
    const verified = await verify(downloadedPath)
    return { executablePath: downloadedPath, sha256Hex: verified.sha256Hex, version, source }
  }
  const extracted = path.join(context.directory, `agy-${source}`)
  await extractAntigravityCliArchive(downloadedPath, extracted)
  await fs.promises.rm(downloadedPath, { force: true })
  await verifyDarwinAntigravityCli(extracted, context.architecture, options.runDarwinProcess ?? defaultRunDarwinProcess)
  return { executablePath: extracted, sha256Hex: await hashFile(extracted, 'sha256'), version, source }
}

function downloadFileName(platform: AntigravityCliPlatform, source: StagedAntigravityCli['source']): string {
  return platform.startsWith('windows_') ? `agy-${source}-download.exe` : `agy-${source}-download.tar.gz`
}

/**
 * 先从星芒存储桶下谷歌签过名的同一份：清单里的大小、SHA-256 绑住下载，SHA-512 再对一遍谷歌清单里的那个值，
 * 下完照样核谷歌签名。读不到、对不上、核不过都删掉、返回 null，照旧去谷歌，原因只进日志；客户点的取消原样抛出。
 */
async function downloadFromBucket(context: InstallContext): Promise<StagedAntigravityCli | null> {
  const { options } = context
  if (!options.bucket) return null
  const filePath = path.join(context.directory, downloadFileName(context.platform, 'bucket'))
  try {
    const release = await readAntigravityCliBucketRelease(context.platform, context.fetchImpl, options.signal)
    await downloadDesktopBucketPackage(release, filePath, {
      fetch: context.fetchImpl,
      ...(options.signal ? { signal: options.signal } : {}),
      onProgress: ({ transferred, total, percent }) => options.onProgress?.({ transferred, total, percent }),
    })
    if (await hashFile(filePath, 'sha512') !== release.sha512) throw new Error('存储桶里的文件和谷歌清单的 SHA-512 不一致')
    return await verifyDownloaded(context, filePath, release.version, 'bucket')
  } catch (error) {
    await fs.promises.rm(filePath, { force: true }).catch(() => undefined)
    await fs.promises.rm(path.join(context.directory, 'agy-bucket'), { force: true }).catch(() => undefined)
    options.signal?.throwIfAborted()
    options.bucket.onFallback?.(`antigravity-cli-${context.platform}：${compactError(error)}`)
    return null
  }
}

async function readGoogleManifest(context: InstallContext) {
  const url = buildAntigravityCliManifestUrl(context.platform)
  const timeout = AbortSignal.timeout(manifestTimeoutMs)
  const signal = context.options.signal ? AbortSignal.any([context.options.signal, timeout]) : timeout
  const response = await context.fetchImpl(url, { headers: { Accept: 'application/json' }, redirect: 'error', credentials: 'omit', signal })
  if (response.url && new URL(response.url).host !== allowedManifestHost) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error('谷歌的版本清单被转到了别的地址')
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`谷歌的版本清单返回 HTTP ${response.status}`)
  }
  return parseAntigravityCliManifest(await readBoundedResponseText(response, maximumAntigravityCliManifestBytes, 'Antigravity 命令行版本清单'), context.platform)
}

async function downloadFromGoogle(context: InstallContext): Promise<StagedAntigravityCli> {
  const { options } = context
  const filePath = path.join(context.directory, downloadFileName(context.platform, 'google'))
  try {
    const release = await readGoogleManifest(context)
    let total = 0
    let lastPercent = -1
    const download = await downloadWithResume({
      targetPath: filePath,
      fileMode: 0o600,
      maximumBytes: maximumAntigravityCliArtifactBytes,
      oversizeMessage: '下载数据超过声明的文件大小',
      ...(options.signal ? { signal: options.signal } : {}),
      responseTimeoutMs: connectionTimeoutMs,
      idleTimeoutMs,
      request: async (headers, signal) => {
        const response = await context.fetchImpl(release.url, { method: 'GET', headers: { Accept: 'application/octet-stream', ...headers }, redirect: 'error', credentials: 'omit', signal })
        // Checked on every request, resumes included.
        if (response.url && (response.url !== release.url || new URL(response.url).host !== allowedArtifactHost)) {
          await response.body?.cancel().catch(() => undefined)
          throw new Error('谷歌的下载被转到了别的地址')
        }
        return response
      },
      // No Content-Type pin: Google serves the Mac archive as application/x-tar (seen 2026-11-23).
      // The SHA-512 from the manifest and Google's signature are what decide.
      acceptResponse: (response) => {
        if (!response.ok) throw new Error(`返回 HTTP ${response.status}`)
        const declared = Number(response.headers.get('content-length'))
        if (!Number.isSafeInteger(declared) || declared < minimumAntigravityCliArtifactBytes || declared > maximumAntigravityCliArtifactBytes) {
          throw new Error('Antigravity 命令行安装包的大小不在 1 MiB 至 512 MiB 之间')
        }
        if (!response.body) throw new Error('没有响应正文')
        total = declared
        return declared
      },
      onProgress: (transferred) => {
        const percent = Math.min(100, Math.floor((transferred / total) * 100))
        if (percent === lastPercent) return
        lastPercent = percent
        options.onProgress?.({ transferred, total, percent })
      },
    })
    if (download.size !== total) throw new Error(`下载不完整：应为 ${total} 字节，实际 ${download.size} 字节`)
    if (await hashFile(filePath, 'sha512') !== release.sha512) throw new Error('下载的文件和谷歌清单的 SHA-512 不一致')
    return await verifyDownloaded(context, filePath, release.version, 'google')
  } catch (error) {
    await fs.promises.rm(filePath, { force: true }).catch(() => undefined)
    options.signal?.throwIfAborted()
    // Somebody else's build is reported as such, not as a download problem worth retrying.
    if (error instanceof NativeCliPublisherMismatchError) throw new AntigravityCliNotOfficialError()
    if (error instanceof DarwinCliProvenanceError) throw error
    // 原因（摘要不符、跳转）留在 cause 里，随错误一起进运行日志；客户只看这一句，超时的另说一句检查网络。
    throw new Error(compactError(error) === downloadTimeoutText ? 'Antigravity 命令行下载超时，请检查网络后重试' : 'Antigravity 命令行下载未完成或校验未通过，请稍后重试', { cause: error })
  }
}

function isReplaceBlocked(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
}

/**
 * The verified file is copied beside the destination (same folder, so the rename is atomic),
 * compared by SHA-256 against what was verified, and renamed over it. An existing entry that is
 * not a plain file (a link, a folder) is somebody's own arrangement and is left alone.
 */
async function placeVerifiedExecutable(staged: StagedAntigravityCli, target: AntigravityCliInstallTarget, platform: NodeJS.Platform): Promise<void> {
  const label = 'Antigravity 命令行的安装位置'
  ensureSafeDataDirectory(target.directory, label)
  function assertDestinationReplaceable(): void {
    assertNoReparseComponents(target.directory, label)
    let stats: fs.Stats
    try {
      stats = fs.lstatSync(target.executablePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('Antigravity 命令行的安装位置已被其他文件占用，星芒不会覆盖')
  }
  assertDestinationReplaceable()
  const extension = platform === 'win32' ? '.exe' : ''
  const pending = path.join(target.directory, `.agy-${randomUUID()}.pending${extension}`)
  try {
    await fs.promises.copyFile(staged.executablePath, pending, fs.constants.COPYFILE_EXCL)
    if (platform !== 'win32') await fs.promises.chmod(pending, 0o755)
    assertPlainSingleLinkFile(pending, 'Antigravity 命令行的暂存文件')
    if (await hashFile(pending, 'sha256') !== staged.sha256Hex) throw new Error('Antigravity 命令行复制后 SHA-256 校验失败')
    try {
      await renameWithTransientRetry(pending, target.executablePath, assertDestinationReplaceable)
    } catch (error) {
      if (platform === 'win32' && isReplaceBlocked(error) && fs.existsSync(target.executablePath)) throw new AntigravityCliInUseError()
      throw error
    }
  } finally {
    await fs.promises.rm(pending, { force: true }).catch(() => undefined)
  }
}

export async function installAntigravityCli(options: InstallAntigravityCliOptions): Promise<InstalledAntigravityCli> {
  const platform = options.platform ?? process.platform
  const architecture = options.architecture ?? process.arch
  const antigravityPlatform = resolveAntigravityCliPlatform(platform, architecture)
  if (!antigravityPlatform || (architecture !== 'x64' && architecture !== 'arm64')) {
    throw new Error('当前电脑的系统或处理器不支持 Antigravity')
  }
  if (platform === 'win32' && options.executionMode !== 'same-user') throw new AntigravityCliElevatedSessionError()
  const env = options.env ?? process.env
  const target = options.target ?? resolveAntigravityCliInstallTarget(platform, env, options.homeDirectory ?? os.homedir())
  if (!target) throw new Error('当前电脑的系统或处理器不支持 Antigravity')
  const directory = await (options.createTemporaryDirectory ? options.createTemporaryDirectory() : createTrustedTemporaryDirectory('antigravity-cli'))
  try {
    const context: InstallContext = { platform: antigravityPlatform, architecture, directory, fetchImpl: options.fetchImpl ?? fetch, options }
    const staged = await downloadFromBucket(context)
      ?? await (options.withVendorDownloadRoute ? options.withVendorDownloadRoute(() => downloadFromGoogle(context)) : downloadFromGoogle(context))
    options.signal?.throwIfAborted()
    await placeVerifiedExecutable(staged, target, platform)
    const installed: InstalledAntigravityCli = { version: staged.version, executablePath: target.executablePath, source: staged.source }
    if (platform === 'win32') {
      installed.userPath = await (options.ensureWindowsUserPath ?? ensureDirectoryOnWindowsUserPath)(target.directory)
    }
    return installed
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** agy 在不在它该在的地方：只看那里是不是一个普通文件，不运行它。 */
export function inspectAntigravityCliInstallation(target: AntigravityCliInstallTarget): { installed: boolean } {
  try {
    const stats = fs.lstatSync(target.executablePath)
    return { installed: stats.isFile() && !stats.isSymbolicLink() }
  } catch {
    return { installed: false }
  }
}

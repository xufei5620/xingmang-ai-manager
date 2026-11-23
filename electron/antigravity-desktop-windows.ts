import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  antigravityDesktopArtifactOrigin,
  antigravityDesktopFeedOrigin,
  buildAntigravityDesktopFeedUrl,
  maximumAntigravityDesktopFeedBytes,
  parseAntigravityDesktopFeed,
  resolveAntigravityDesktopPlatform,
  type AntigravityDesktopRelease,
} from './antigravity-desktop-release'
import { readBoundedResponseText } from './bounded-response'
import { commandEnvironment, runCommand } from './command-runner'
import { downloadWithResume, DownloadStalledError } from './download-retry'
import { NativeCliPublisherMismatchError, verifyOfficialNativeCliFile } from './trusted-native-cli'
import { createTrustedTemporaryDirectory } from './trusted-temp'
import type { WindowsCliExecutionMode } from './windows-elevation'

/**
 * Windows 上一键装 Antigravity 桌面端：读谷歌桌面端自己更新时读的那份版本信息（antigravity-desktop-release.ts），
 * 下谷歌签名的 NSIS 安装包，静默装（`/S`）。2026-11-23 在 GitHub 的 Windows 临时机器上装过 2.34.0：它是一键式的
 * 按用户安装，不问目录，固定装到 %LOCALAPPDATA%\Programs\antigravity\Antigravity.exe，卸载项在 HKCU，不要管理员；
 * 装完不自己打开。Antigravity 正开着时再装，安装程序会先把它关掉（实测 6 个进程全没了），再照常装完、返回 0。
 *
 * 还没有星芒存储桶那一路（桌面端的包还没同步进桶），只问谷歌；整段借加速线路。
 *
 * Trust: the feed and the installer come only from Google's two fixed hosts, redirects refused
 * (I10), and the feed must name exactly the installer URL antigravity-desktop-release.ts builds.
 * The download must be the size and SHA-512 the feed declares, and then carry Google's
 * Authenticode signature: the same pin as the agy CLI in trusted-native-cli.ts (Google LLC under
 * DigiCert Trusted G4 Code Signing RSA4096 SHA384 2021 CA1; both 2.34.0 installers checked). The
 * file is hashed again right before it runs so that what runs is what was checked. Only then is it
 * started, from the trusted installer cache, with an argv array and no shell (I1).
 *
 * The installer writes into the customer's own profile, so a session running as administrator
 * (trusted-only) refuses, as the agy installer does: an elevated program writing into a
 * user-writable folder is what that mode exists to avoid, and an elevated per-user install would
 * land in the administrator's profile anyway.
 *
 * yoyo 打字同意「Antigravity 免核签名」放宽的只是打开前对装好的 Antigravity.exe 的签名校验（它本身没签名），
 * 不是这里：安装包照核谷歌签名，核不过不装。
 */

const feedTimeoutMs = 15_000
const connectionTimeoutMs = 20_000
const idleTimeoutMs = 45_000
// 2.34.0 在临时机器上装了 23 秒；慢盘、杀毒软件扫一遍会久得多，只为不让它永远挂着。
const installerTimeoutMs = 10 * 60_000
const allowedFeedHost = new URL(antigravityDesktopFeedOrigin).host
const allowedArtifactHost = new URL(antigravityDesktopArtifactOrigin).host

export interface AntigravityDesktopWindowsProgress {
  phase: 'downloading' | 'verifying' | 'installing'
  /** 只有下载时有。 */
  percent: number | null
}

/** 管理员身份打开的星芒不替客户装进用户自己的文件夹（见文件头）。 */
export class AntigravityDesktopElevatedSessionError extends Error {
  constructor() {
    super('星芒正以管理员身份运行，不能替你安装 Antigravity。请用普通方式重新打开星芒再装。')
    this.name = 'AntigravityDesktopElevatedSessionError'
  }
}

/** 下回来的安装包不是谷歌签名的：删掉，不装。 */
export class AntigravityDesktopNotOfficialError extends Error {
  constructor(cause: unknown) {
    super('下载的 Antigravity 安装包不是谷歌官方签名的，已删除，没有安装。', { cause })
    this.name = 'AntigravityDesktopNotOfficialError'
  }
}

export interface InstallAntigravityDesktopWindowsOptions {
  /** 跟 resolveWindowsCliExecutionMode 的结论走。 */
  executionMode: WindowsCliExecutionMode
  platform?: NodeJS.Platform
  architecture?: NodeJS.Architecture
  env?: NodeJS.ProcessEnv
  homeDirectory?: string
  /** 测试用：直接给出装好以后程序在哪。 */
  executablePath?: string
  fetchImpl?: typeof fetch
  /** 只在开始装之前有用：安装程序一旦开始就等它装完，半截停下会留下装了一半的程序。 */
  signal?: AbortSignal
  onProgress?(progress: AntigravityDesktopWindowsProgress): void
  /** 整段问谷歌的过程（加速线路）。 */
  withVendorDownloadRoute?<T>(operation: () => Promise<T>): Promise<T>
  createTemporaryDirectory?(): Promise<string>
  verifyInstaller?(filePath: string): Promise<{ size: number; sha256Hex: string }>
  runInstaller?(installerPath: string): Promise<void>
}

export interface InstalledAntigravityDesktop {
  version: string
  executablePath: string
}

/** 一键式按用户安装的固定位置；不是 Windows 就是 null。 */
export function resolveAntigravityDesktopWindowsExecutable(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, homeDirectory: string): string | null {
  if (platform !== 'win32') return null
  const fromEnvironment = env.LOCALAPPDATA?.trim()
  const localAppData = fromEnvironment && path.win32.isAbsolute(fromEnvironment)
    ? fromEnvironment
    : path.win32.join(homeDirectory, 'AppData', 'Local')
  return path.win32.join(localAppData, 'Programs', 'antigravity', 'Antigravity.exe')
}

/** 装没装：只看固定位置是不是一个普通文件，不运行它。 */
export function inspectAntigravityDesktopWindowsInstallation(executablePath: string): { installed: boolean } {
  try {
    const stats = fs.lstatSync(executablePath)
    return { installed: stats.isFile() && !stats.isSymbolicLink() }
  } catch {
    return { installed: false }
  }
}

function compactError(error: unknown): string {
  const candidate = error as { name?: unknown; message?: unknown }
  if (candidate?.name === 'AbortError' || candidate?.name === 'TimeoutError' || error instanceof DownloadStalledError) return '连接或下载超时'
  const message = typeof candidate?.message === 'string' ? candidate.message : String(error)
  return message.replace(/\s+/g, ' ').trim().slice(0, 300) || '下载失败'
}

async function hashFile(filePath: string, algorithm: 'sha256' | 'sha512'): Promise<string> {
  const hash = createHash(algorithm)
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

async function readFeed(platform: AntigravityDesktopRelease['platform'], fetchImpl: typeof fetch, signal: AbortSignal | undefined): Promise<AntigravityDesktopRelease> {
  const timeout = AbortSignal.timeout(feedTimeoutMs)
  const response = await fetchImpl(buildAntigravityDesktopFeedUrl(platform), {
    headers: { Accept: '*/*' },
    redirect: 'error',
    credentials: 'omit',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
  if (response.url && new URL(response.url).host !== allowedFeedHost) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error('谷歌的版本信息被转到了别的地址')
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`谷歌的版本信息返回 HTTP ${response.status}`)
  }
  const release = parseAntigravityDesktopFeed(await readBoundedResponseText(response, maximumAntigravityDesktopFeedBytes, 'Antigravity 版本信息'), platform)
  if (!release) throw new Error('谷歌的版本信息里没有这台电脑能用的安装包')
  return release
}

async function downloadInstaller(release: AntigravityDesktopRelease, filePath: string, options: InstallAntigravityDesktopWindowsOptions, fetchImpl: typeof fetch): Promise<void> {
  let lastPercent = -1
  const download = await downloadWithResume({
    targetPath: filePath,
    fileMode: 0o600,
    // 版本信息写了多大就只收这么多。
    maximumBytes: release.bytes,
    oversizeMessage: '下载数据超过版本信息写的大小',
    ...(options.signal ? { signal: options.signal } : {}),
    responseTimeoutMs: connectionTimeoutMs,
    idleTimeoutMs,
    request: async (headers, signal) => {
      const response = await fetchImpl(release.url, { method: 'GET', headers: { Accept: 'application/octet-stream', ...headers }, redirect: 'error', credentials: 'omit', signal })
      // Checked on every request, resumes included.
      if (response.url && (response.url !== release.url || new URL(response.url).host !== allowedArtifactHost)) {
        await response.body?.cancel().catch(() => undefined)
        throw new Error('谷歌的下载被转到了别的地址')
      }
      return response
    },
    acceptResponse: (response) => {
      if (!response.ok) throw new Error(`返回 HTTP ${response.status}`)
      const declared = Number(response.headers.get('content-length'))
      if (declared !== release.bytes) throw new Error(`安装包大小是 ${response.headers.get('content-length') ?? '未知'}，版本信息写的是 ${release.bytes}`)
      if (!response.body) throw new Error('没有响应正文')
      return declared
    },
    onProgress: (transferred) => {
      const percent = Math.min(99, Math.floor((transferred / release.bytes) * 100))
      if (percent === lastPercent) return
      lastPercent = percent
      options.onProgress?.({ phase: 'downloading', percent })
    },
  })
  if (download.size !== release.bytes) throw new Error(`下载不完整：应为 ${release.bytes} 字节，实际 ${download.size} 字节`)
  if (await hashFile(filePath, 'sha512') !== release.sha512) throw new Error('下载的安装包和谷歌版本信息里的 SHA-512 不一致')
}

function defaultRunInstaller(installerPath: string): Promise<void> {
  // Same-user only (checked before this runs), so the ordinary sanitized environment applies (I2).
  return runCommand({ executable: installerPath, argv: ['/S'] }, {
    env: commandEnvironment(),
    trustedOnly: false,
    timeoutMs: installerTimeoutMs,
    timeoutExcludesSleep: true,
    acceptedExitCodes: [0],
    windowsHide: true,
    maxOutputBytes: 1024 * 1024,
  }).then(() => undefined)
}

export async function installAntigravityDesktopWindows(options: InstallAntigravityDesktopWindowsOptions): Promise<InstalledAntigravityDesktop> {
  const platform = options.platform ?? process.platform
  const desktopPlatform = resolveAntigravityDesktopPlatform(platform, options.architecture ?? process.arch)
  if (platform !== 'win32' || !desktopPlatform) throw new Error('这台电脑的系统或芯片不支持一键安装 Antigravity')
  const feedPlatform = desktopPlatform
  if (options.executionMode !== 'same-user') throw new AntigravityDesktopElevatedSessionError()
  const executablePath = options.executablePath ?? resolveAntigravityDesktopWindowsExecutable(platform, options.env ?? process.env, options.homeDirectory ?? os.homedir())
  if (!executablePath) throw new Error('这台电脑的系统或芯片不支持一键安装 Antigravity')
  const fetchImpl = options.fetchImpl ?? fetch
  const directory = await (options.createTemporaryDirectory ? options.createTemporaryDirectory() : createTrustedTemporaryDirectory('antigravity-desktop'))
  try {
    const installerPath = path.join(directory, 'antigravity-setup.exe')
    async function fetchAndVerify(): Promise<{ release: AntigravityDesktopRelease; sha256Hex: string }> {
      try {
        options.onProgress?.({ phase: 'downloading', percent: 0 })
        const release = await readFeed(feedPlatform, fetchImpl, options.signal)
        await downloadInstaller(release, installerPath, options, fetchImpl)
        options.onProgress?.({ phase: 'verifying', percent: null })
        let verified: { size: number; sha256Hex: string }
        try {
          verified = await (options.verifyInstaller ?? ((filePath: string) => verifyOfficialNativeCliFile('antigravity', filePath)))(installerPath)
        } catch (error) {
          if (error instanceof NativeCliPublisherMismatchError) throw new AntigravityDesktopNotOfficialError(error)
          throw error
        }
        if (verified.size !== release.bytes) throw new Error('安装包在核对签名时变了')
        return { release, sha256Hex: verified.sha256Hex }
      } catch (error) {
        await fs.promises.rm(installerPath, { force: true }).catch(() => undefined)
        options.signal?.throwIfAborted()
        if (error instanceof AntigravityDesktopNotOfficialError) throw error
        throw new Error(`Antigravity 安装包下载或签名校验失败：${compactError(error)}`, { cause: error })
      }
    }
    const { release, sha256Hex } = await (options.withVendorDownloadRoute ? options.withVendorDownloadRoute(fetchAndVerify) : fetchAndVerify())
    options.signal?.throwIfAborted()
    // What runs must be the bytes whose signature was just checked.
    if (await hashFile(installerPath, 'sha256') !== sha256Hex) throw new Error('Antigravity 安装包在校验后被修改，没有安装')
    options.onProgress?.({ phase: 'installing', percent: null })
    try {
      await (options.runInstaller ?? defaultRunInstaller)(installerPath)
    } catch (error) {
      throw new Error(`Antigravity 安装程序没有装完：${compactError(error)}`, { cause: error })
    }
    if (!inspectAntigravityDesktopWindowsInstallation(executablePath).installed) {
      throw new Error('Antigravity 安装程序已运行完，但没有在它的安装位置找到 Antigravity')
    }
    return { version: release.version, executablePath }
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => undefined)
  }
}

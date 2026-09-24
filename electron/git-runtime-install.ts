import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  runCommand,
  trustedCommandEnvironment,
  type CommandResult,
  type RunCommandOptions,
} from './command-runner'
import type { NodeRuntimeNetworkRegion, NodeRuntimeProcessPlan } from './node-runtime'
import { createTrustedTemporaryDirectory } from './trusted-temp'
import { resolveWindowsMachinePaths, type WindowsMachinePaths } from './windows-machine-paths'

/**
 * Git for Windows 由本软件代装（yoyo 2026-09-24：缺 Git 时让客户自己去官网找安装包，
 * 小白卡在这一步）。和 Node.js / Python 不同，这里**钉死一个版本和它的 SHA-256**：
 *
 * - Git for Windows 没有像 nodejs.org 的 SHASUMS256.txt 那样能从镜像旁边一起拿到的校验
 *   清单，官方摘要只写在 GitHub 发布说明里；从镜像取摘要等于让镜像自己给自己作证。
 *   摘要写在代码里，镜像给的文件只要差一个字节就装不上。
 * - 安装器是 Inno Setup，`PrivilegesRequired=none`：普通权限运行时按当前用户安装、
 *   只改当前用户的 PATH，不弹管理员授权（build-extra/installer/install.iss）。
 *
 * 升级版本：改下面三个常量，摘要从 Git for Windows 发布页的「SHA-256 checksums」表抄。
 */
export const gitForWindowsVersion = '2.55.0.5'
export const gitForWindowsTag = 'v2.55.0.windows.5'
const gitForWindowsSha256: Record<GitRuntimeArchitecture, string> = {
  x64: 'd065a4e23c3d9a6b5073d609b5be0830227ec3ca053c083ba385061ddfaf94c6',
  arm64: 'c955de342b1465bc637f0e71fddf4e28e8d0b829668ec1866ab32a839303e8e3',
}

export type GitRuntimeArchitecture = 'x64' | 'arm64'
export type GitRuntimeSource = 'npmmirror' | 'official'
export type GitRuntimeInstallPhase =
  | 'checking'
  | 'downloading'
  | 'verifying'
  | 'installing'
  | 'complete'
  | 'error'

export interface GitRuntimeInstallProgress {
  phase: GitRuntimeInstallPhase
  source: GitRuntimeSource | null
  message: string
  percent: number | null
  transferredBytes?: number
  totalBytes?: number | null
}

export interface GitRuntimeInstallResult {
  installed: true
  action: 'installed' | 'unchanged'
  source: GitRuntimeSource | null
  version: string | null
  architecture: GitRuntimeArchitecture
  pathRefreshRequired: boolean
}

export interface GitRuntimeDownloadSource {
  id: GitRuntimeSource
  label: string
  url: string
}

export interface GitRuntimeInstallerDependencies {
  fetch: typeof globalThis.fetch
  /** 测试接缝：真实摘要属于真实安装包，合成的下载内容永远对不上。 */
  expectedSha256(architecture: GitRuntimeArchitecture): string
  runProcess(plan: NodeRuntimeProcessPlan, signal?: AbortSignal): Promise<CommandResult>
  createTemporaryDirectory(): Promise<string>
  removeTemporaryDirectory(directory: string): Promise<void>
}

export interface InstallGitRuntimeOptions {
  networkRegion: NodeRuntimeNetworkRegion
  architecture?: NodeJS.Architecture
  signal?: AbortSignal
  onProgress?: (progress: GitRuntimeInstallProgress) => void
  temporaryDirectoryMode?: 'trusted-only' | 'same-user'
  /** 决定当前用户程序目录的环境变量；缺省 process.env，测试用它模拟 Windows。 */
  environment?: NodeJS.ProcessEnv
  dependencies?: Partial<GitRuntimeInstallerDependencies>
}

const downloadTimeoutMs = 10 * 60_000
const installerTimeoutMs = 15 * 60_000
const minimumInstallerBytes = 20 * 1024 * 1024
const maximumInstallerBytes = 200 * 1024 * 1024
const maximumRedirects = 5
const redirectStatuses = new Set([301, 302, 303, 307, 308])

function report(options: InstallGitRuntimeOptions, progress: GitRuntimeInstallProgress): void {
  options.onProgress?.(progress)
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error('操作已取消')
}

function errorText(reason: unknown): string {
  if (reason instanceof Error && reason.message.trim()) return reason.message.trim()
  if (typeof reason === 'string' && reason.trim()) return reason.trim()
  return '未知错误'
}

export function normalizeGitRuntimeArchitecture(architecture: NodeJS.Architecture): GitRuntimeArchitecture {
  if (architecture === 'x64' || architecture === 'arm64') return architecture
  throw new Error(`这台电脑的处理器（${architecture}）暂时不能自动安装 Git`)
}

export function gitForWindowsInstallerFileName(architecture: GitRuntimeArchitecture): string {
  return `Git-${gitForWindowsVersion}-${architecture === 'arm64' ? 'arm64' : '64-bit'}.exe`
}

export function gitForWindowsExpectedSha256(architecture: GitRuntimeArchitecture): string {
  return gitForWindowsSha256[architecture]
}

/**
 * 与 nodeRuntimeDownloadSources 同一条规则：地区探测失败多半就是在连不上官方的网络里，
 * 所以只有明确在境外才先走官方。两路都会试，猜错只影响先后。
 */
export function gitRuntimeDownloadSources(
  region: NodeRuntimeNetworkRegion,
  architecture: GitRuntimeArchitecture,
): [GitRuntimeDownloadSource, GitRuntimeDownloadSource] {
  const fileName = gitForWindowsInstallerFileName(architecture)
  const mirror: GitRuntimeDownloadSource = {
    id: 'npmmirror',
    label: '国内镜像',
    url: `https://npmmirror.com/mirrors/git-for-windows/${gitForWindowsTag}/${fileName}`,
  }
  const official: GitRuntimeDownloadSource = {
    id: 'official',
    label: 'Git 官方源',
    url: `https://github.com/git-for-windows/git/releases/download/${gitForWindowsTag}/${fileName}`,
  }
  return region === 'outside-mainland-china' ? [official, mirror] : [mirror, official]
}

/**
 * The pinned SHA-256 is what authenticates the installer, so this is defence in
 * depth: it keeps the request (and the proxy it goes through) on the two hosts
 * that serve Git for Windows. npmmirror answers from its fixed CDN mapping;
 * GitHub answers with a signed, query-bearing URL on its release-asset hosts.
 */
export function validateGitRuntimeDownloadUrl(value: string): void {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('Git 安装包下载地址无效')
  }
  if (parsed.protocol !== 'https:' || parsed.port || parsed.username || parsed.password || parsed.hash) {
    throw new Error('Git 安装包下载跳转到了未经批准的地址')
  }
  const host = parsed.hostname.toLowerCase()
  const pathname = parsed.pathname
  if (pathname.includes('\\') || /(?:^|\/)\.\.?($|\/)/.test(pathname)) {
    throw new Error('Git 安装包下载跳转到了未经批准的地址')
  }
  const mirrorPath = (host === 'npmmirror.com' && pathname.startsWith('/mirrors/git-for-windows/'))
    || (host === 'cdn.npmmirror.com' && pathname.startsWith('/binaries/git-for-windows/'))
    || (host === 'registry.npmmirror.com' && pathname.startsWith('/-/binary/git-for-windows/'))
  const officialPath = host === 'github.com' && pathname.startsWith('/git-for-windows/git/releases/download/')
  const releaseAsset = host === 'objects.githubusercontent.com' || host === 'release-assets.githubusercontent.com'
  if ((mirrorPath || officialPath) && !parsed.search) return
  if (releaseAsset) return
  throw new Error('Git 安装包下载跳转到了未经批准的地址')
}

async function fetchTrustedGitResource(
  url: string,
  init: RequestInit,
  fetchImplementation: typeof globalThis.fetch,
): Promise<Response> {
  validateGitRuntimeDownloadUrl(url)
  let current = url
  const visited = new Set<string>()
  for (let redirectCount = 0; redirectCount <= maximumRedirects; redirectCount += 1) {
    if (visited.has(current)) throw new Error('Git 安装包下载发生了循环跳转')
    visited.add(current)
    const response = await fetchImplementation(current, { ...init, redirect: 'manual' })
    if (response.url) validateGitRuntimeDownloadUrl(response.url)
    if (!redirectStatuses.has(response.status)) return response
    const location = response.headers.get('location')
    if (!location) throw new Error('Git 安装包下载跳转缺少目标地址')
    await response.body?.cancel().catch(() => undefined)
    const next = new URL(location, current).href
    validateGitRuntimeDownloadUrl(next)
    current = next
  }
  throw new Error('Git 安装包下载跳转次数过多')
}

async function downloadInstaller(
  source: GitRuntimeDownloadSource,
  targetPath: string,
  options: InstallGitRuntimeOptions,
  dependencies: GitRuntimeInstallerDependencies,
): Promise<{ sha256: string; size: number }> {
  const controller = new AbortController()
  const abort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(() => controller.abort(new Error('下载超时')), downloadTimeoutMs)
  const hash = createHash('sha256')
  let size = 0
  let file: fs.promises.FileHandle | null = null
  try {
    throwIfAborted(options.signal)
    const response = await fetchTrustedGitResource(source.url, {
      method: 'GET',
      signal: controller.signal,
      headers: { Accept: 'application/octet-stream' },
    }, dependencies.fetch)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    if (!response.body) throw new Error('服务器没有返回安装包内容')
    const declaredHeader = response.headers.get('content-length')
    const declared = declaredHeader === null ? null : Number(declaredHeader)
    if (declared !== null && (!Number.isSafeInteger(declared) || declared < minimumInstallerBytes)) {
      throw new Error('服务器返回的安装包大小无效')
    }
    if (declared !== null && declared > maximumInstallerBytes) throw new Error('安装包超过 200 MB 安全限制')
    file = await fs.promises.open(targetPath, 'wx')
    const reader = response.body.getReader()
    while (true) {
      throwIfAborted(options.signal)
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      size += value.byteLength
      if (size > maximumInstallerBytes) {
        await reader.cancel()
        throw new Error('安装包超过 200 MB 安全限制')
      }
      hash.update(value)
      await file.write(value)
      report(options, {
        phase: 'downloading',
        source: source.id,
        message: `正在从${source.label}下载 Git`,
        percent: declared ? Math.min(99, (size / declared) * 100) : null,
        transferredBytes: size,
        totalBytes: declared,
      })
    }
    await file.sync()
    await file.close()
    file = null
    if (size < minimumInstallerBytes) throw new Error('下载的安装包内容过小')
    if (declared !== null && size !== declared) throw new Error('安装包下载不完整')
    return { sha256: hash.digest('hex'), size }
  } catch (error) {
    await file?.close().catch(() => undefined)
    await fs.promises.rm(targetPath, { force: true }).catch(() => undefined)
    throw error
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abort)
  }
}

async function hashFileSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

/** Git for Windows 在非管理员安装时的默认落点（Inno Setup 的 {userpf}\Git）。 */
export function gitForWindowsUserInstallDirectory(env: NodeJS.ProcessEnv = process.env): string | null {
  const localAppData = env.LOCALAPPDATA?.trim()
  return localAppData ? path.win32.join(localAppData, 'Programs', 'Git') : null
}

/**
 * Inno Setup 的静默参数。同用户模式下把目录钉在当前用户的程序目录：安装器在静默模式
 * 下不会走「默认目录写不进去就改用户目录」那段界面逻辑，不给 /DIR 会去试 Program Files。
 *
 * 以管理员身份运行（trusted-only）时**不**给 /DIR：那时安装器改的是系统 PATH，
 * 让系统 PATH 指向普通用户可写的目录，等于把之后每个管理员进程找到的 git 交给
 * 普通用户决定。留给安装器默认的 Program Files。
 */
export function buildGitRuntimeInstallPlan(
  installerPath: string,
  trustedOnly = true,
  env: NodeJS.ProcessEnv = process.env,
  machinePaths?: WindowsMachinePaths,
): NodeRuntimeProcessPlan {
  if (!path.win32.isAbsolute(installerPath) || installerPath.includes('\0')) {
    throw new Error('Git 安装包路径无效')
  }
  const argv = ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/NOCANCEL', '/SP-']
  if (!trustedOnly) {
    const directory = gitForWindowsUserInstallDirectory(env)
    if (!directory) throw new Error('找不到当前用户的程序目录，没法安装 Git')
    argv.push(`/DIR=${directory}`)
  }
  const roots = machinePaths ?? (process.platform === 'win32' ? resolveWindowsMachinePaths() : undefined)
  return {
    executable: installerPath,
    argv,
    timeoutMs: installerTimeoutMs,
    acceptedExitCodes: [0],
    env: trustedCommandEnvironment(env, roots, roots ? 'win32' : process.platform),
    trustedPaths: [installerPath],
    ...(!trustedOnly ? { trustedOnly: false } : {}),
  }
}

async function defaultRunProcess(plan: NodeRuntimeProcessPlan, signal?: AbortSignal): Promise<CommandResult> {
  const options: RunCommandOptions = {
    timeoutMs: plan.timeoutMs,
    acceptedExitCodes: plan.acceptedExitCodes,
    maxOutputBytes: 2 * 1024 * 1024,
    windowsHide: true,
    signal,
    env: plan.env,
    trustedOnly: plan.trustedOnly ?? true,
    trustedPaths: plan.trustedPaths,
  }
  return runCommand({ executable: plan.executable, argv: [...plan.argv] }, options)
}

const defaultDependencies: GitRuntimeInstallerDependencies = {
  fetch: globalThis.fetch,
  expectedSha256: gitForWindowsExpectedSha256,
  runProcess: defaultRunProcess,
  createTemporaryDirectory: () => createTrustedTemporaryDirectory('git-runtime'),
  removeTemporaryDirectory: (directory) => fs.promises.rm(directory, { recursive: true, force: true }),
}

async function installFromSource(
  source: GitRuntimeDownloadSource,
  architecture: GitRuntimeArchitecture,
  temporaryDirectory: string,
  options: InstallGitRuntimeOptions,
  dependencies: GitRuntimeInstallerDependencies,
): Promise<void> {
  const expectedSha256 = dependencies.expectedSha256(architecture)
  // 前一个源失败可能留下半截文件，各源分开放。
  const installerPath = path.join(temporaryDirectory, `${source.id}-${gitForWindowsInstallerFileName(architecture)}`)
  report(options, {
    phase: 'downloading',
    source: source.id,
    message: `正在从${source.label}下载 Git`,
    percent: 0,
  })
  const download = await downloadInstaller(source, installerPath, options, dependencies)
  report(options, { phase: 'verifying', source: source.id, message: '正在检查安装包是否完好', percent: null })
  if (download.sha256 !== expectedSha256) throw new Error('安装包和官方发布的不一致')
  const trustedOnly = options.temporaryDirectoryMode !== 'same-user'
  const plan = buildGitRuntimeInstallPlan(installerPath, trustedOnly, options.environment ?? process.env)
  const stat = await fs.promises.stat(installerPath)
  if (!stat.isFile() || stat.size !== download.size || await hashFileSha256(installerPath) !== expectedSha256) {
    throw new Error('安装包在检查后被改动过')
  }
  report(options, { phase: 'installing', source: source.id, message: '正在安装 Git', percent: null })
  await dependencies.runProcess(plan, options.signal)
}

/**
 * Windows 上自动装 Git for Windows：国内镜像与官方两路按地区排先后，下载后对照
 * 钉在代码里的 SHA-256，普通权限下装到当前用户目录，不弹管理员授权。
 */
export async function installGitRuntime(options: InstallGitRuntimeOptions): Promise<GitRuntimeInstallResult> {
  if (process.platform !== 'win32') throw new Error('Git 自动安装当前仅支持 Windows')
  const architecture = normalizeGitRuntimeArchitecture(options.architecture ?? process.arch)
  const dependencies: GitRuntimeInstallerDependencies = {
    ...defaultDependencies,
    ...(options.temporaryDirectoryMode === 'same-user'
      ? { createTemporaryDirectory: () => fs.promises.mkdtemp(path.join(os.tmpdir(), 'xingmang-git-runtime-')) }
      : {}),
    ...options.dependencies,
  }
  return installGitRuntimeWith(architecture, options, dependencies)
}

/** 与平台无关的主体，测试直接调它，不必伪装成 Windows。 */
export async function installGitRuntimeWith(
  architecture: GitRuntimeArchitecture,
  options: InstallGitRuntimeOptions,
  dependencies: GitRuntimeInstallerDependencies,
): Promise<GitRuntimeInstallResult> {
  throwIfAborted(options.signal)
  const failures: string[] = []
  let temporaryDirectory: string
  try {
    temporaryDirectory = await dependencies.createTemporaryDirectory()
  } catch (error) {
    const message = `Git 没装上：临时目录建不起来（${errorText(error)}）`
    report(options, { phase: 'error', source: null, message, percent: null })
    throw new Error(message)
  }
  try {
    for (const source of gitRuntimeDownloadSources(options.networkRegion, architecture)) {
      throwIfAborted(options.signal)
      try {
        await installFromSource(source, architecture, temporaryDirectory, options, dependencies)
        report(options, { phase: 'complete', source: source.id, message: 'Git 装好了', percent: 100 })
        return {
          installed: true,
          action: 'installed',
          source: source.id,
          version: gitForWindowsVersion,
          architecture,
          pathRefreshRequired: true,
        }
      } catch (error) {
        if (options.signal?.aborted) throw error
        failures.push(`${source.label}：${errorText(error)}`)
        report(options, {
          phase: 'checking',
          source: source.id,
          message: `${source.label}没下好，正在换一个下载地址`,
          percent: null,
        })
      }
    }
  } finally {
    await dependencies.removeTemporaryDirectory(temporaryDirectory).catch(() => undefined)
  }
  const message = `Git 没装上。${failures.join('；')}`
  report(options, { phase: 'error', source: null, message, percent: null })
  throw new Error(message)
}

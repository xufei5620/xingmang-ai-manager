import fs from 'node:fs'
import path from 'node:path'
import {
  runCommand,
  type CommandResult,
} from './command-runner'
import { managedNodeRuntimeRoot, managedProductRoot } from './managed-cli-paths'
import {
  downloadNodeRuntimePackage,
  nodeRuntimeDownloadSources,
  nodeRuntimeSourceUrl,
  type InstallNodeRuntimeOptions,
  type NodeRuntimeArchitecture,
  type NodeRuntimeDownloadSource,
  type NodeRuntimeInstallProgress,
  type NodeRuntimeInstallResult,
} from './node-runtime'
import { assertPlainDirectory, ensureTrustedDirectory } from './trusted-temp'
import { nodeVersionStatus } from './versions'

/**
 * Linux 上缺 Node.js（或只有发行版自带、装不了工具的旧版）时由本软件代为准备（Linux 版
 * 拆分 ②）。做法照 Mac（macos-node-runtime.ts）：不提权、不开终端，只把官方 Linux 压缩包
 * 解到产品目录下的 Runtime/node（managed-cli-paths.ts，`~/.local/share/XingMangAI`）。
 *
 * 和 Mac 不同的两处：
 * - 软件内 PATH 里这一份排在最前（linux-platform.ts）。它只在电脑上没有能用的 Node.js 时
 *   才会被装上，而 Ubuntu 22.04/24.04、Debian 12 软件源里那份都低于工具要的版本，排在后面
 *   就永远轮不到它，「准备 Node.js」点了等于没点。
 * - 版本和校验值钉死在下面，不像 Mac 那样每次查最新稳定版。理由见 Trust chain 第 2 条。
 *
 * Trust chain, in order:
 * 1. The archive comes only from nodejs.org or npmmirror's fixed Node mirror, with redirects
 *    pinned to the same resource (node-runtime.ts fetchTrustedNodeResource).
 * 2. Its SHA-256 must equal the digest pinned below for this architecture. Linux has no OS
 *    signature to fall back on (Windows checks the MSI's Authenticode publisher, macOS the
 *    Developer ID on bin/node), so a SHASUMS256.txt fetched next to the bytes would only be
 *    as honest as the mirror serving both. The pin moves that trust to code review: it was
 *    copied from the release's OpenPGP-signed SHASUMS256.txt.asc after checking the signature
 *    against nodejs/release-keys. The mirror then only supplies bytes.
 * 3. tar runs from a fixed root-owned path with only PATH=/usr/bin:/bin and LC_ALL=C in its
 *    environment, so neither tar nor the gzip it spawns for -z is picked from a directory the
 *    user can write, and no TAR_OPTIONS/GZIP variable can add arguments. GNU tar
 *    strips a leading "/" and skips members containing "..", and the digest above already
 *    fixes every member before extraction starts.
 * 4. The extracted binary must report exactly the pinned version.
 *
 * 升级版本：改下面两个常量。摘要从 https://nodejs.org/dist/<版本>/SHASUMS256.txt.asc 抄
 * `node-<版本>-linux-x64.tar.gz` 与 `node-<版本>-linux-arm64.tar.gz` 两行，抄之前先用
 * https://github.com/nodejs/release-keys 的公钥核过签名（gpgv --keyring pubring.kbx …）。
 * 用 .tar.gz 不用 .tar.xz：解压只用到系统必带的 gzip，不依赖 xz。
 */
export const linuxNodeRuntimeVersion = 'v24.21.0'
const linuxNodeRuntimeSha256: Readonly<Record<NodeRuntimeArchitecture, string>> = {
  x64: '6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff',
  arm64: '724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5',
}

export interface LinuxNodeRuntimeRelease {
  version: string
  sha256: string
}

export function linuxNodeRuntimePinnedRelease(architecture: NodeRuntimeArchitecture): LinuxNodeRuntimeRelease {
  return { version: linuxNodeRuntimeVersion, sha256: linuxNodeRuntimeSha256[architecture] }
}

/** Root-owned GNU tar. Kylin/UOS without the merged /usr still keep it at /bin/tar. */
export const linuxTarCandidates = ['/usr/bin/tar', '/bin/tar'] as const

/** Fixed PATH for the extraction, so `tar -z` finds the system gzip and nothing else. */
export const linuxExtractPath = '/usr/bin:/bin'

const stagingPrefix = 'node-staging-'
const extractTimeoutMs = 5 * 60_000
const probeTimeoutMs = 60_000

export interface LinuxNodeRuntimeProcess {
  executable: string
  argv: readonly string[]
  timeoutMs: number
}

export interface LinuxNodeRuntimeDependencies {
  runProcess(plan: LinuxNodeRuntimeProcess, signal?: AbortSignal): Promise<CommandResult>
  /** null = no trustworthy tar on this machine. */
  resolveTar(): string | null
  /** Test seam; production always uses the pinned release above. */
  pinnedRelease(architecture: NodeRuntimeArchitecture): LinuxNodeRuntimeRelease
}

export interface InstallLinuxNodeRuntimeOptions extends InstallNodeRuntimeOptions {
  /** 决定产品目录的环境变量（HOME、XDG_DATA_HOME）；缺省 process.env，测试用它指到临时目录。 */
  environment?: NodeJS.ProcessEnv
  linux?: Partial<LinuxNodeRuntimeDependencies>
}

/**
 * tar and the extracted node get nothing from the app's own environment. trustedCommandEnvironment
 * is built for elevated Windows children and still passes TAR_OPTIONS and GZIP through, and GNU
 * tar reads TAR_OPTIONS as extra arguments (--to-command, --absolute-names, …). Neither program
 * needs more than a fixed PATH and a plain locale here.
 */
export const linuxExtractEnvironment: Readonly<NodeJS.ProcessEnv> = Object.freeze({ PATH: linuxExtractPath, LC_ALL: 'C' })

function defaultRunProcess(plan: LinuxNodeRuntimeProcess, signal?: AbortSignal): Promise<CommandResult> {
  return runCommand({ executable: plan.executable, argv: [...plan.argv] }, {
    env: { ...linuxExtractEnvironment },
    timeoutMs: plan.timeoutMs,
    maxOutputBytes: 2 * 1024 * 1024,
    signal,
  })
}

/**
 * A tar anyone but root can replace would decide what lands in the runtime every CLI then
 * runs under, so only a root-owned file without group/other write access qualifies.
 */
export function isTrustedLinuxSystemExecutable(stats: Pick<fs.Stats, 'uid' | 'mode'> & { isFile(): boolean }): boolean {
  return stats.isFile() && stats.uid === 0 && (stats.mode & 0o022) === 0
}

export function resolveLinuxTarExecutable(
  statFile: (candidate: string) => fs.Stats | null = statOrNull,
): string | null {
  for (const candidate of linuxTarCandidates) {
    const stats = statFile(candidate)
    if (stats && isTrustedLinuxSystemExecutable(stats)) return candidate
  }
  return null
}

function statOrNull(candidate: string): fs.Stats | null {
  try {
    return fs.statSync(candidate)
  } catch {
    return null
  }
}

const defaultDependencies: LinuxNodeRuntimeDependencies = {
  runProcess: defaultRunProcess,
  resolveTar: () => resolveLinuxTarExecutable(),
  pinnedRelease: linuxNodeRuntimePinnedRelease,
}

function report(options: InstallNodeRuntimeOptions, progress: NodeRuntimeInstallProgress): void {
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

/** 官方 Node.js 只出 Intel/AMD 和 ARM 两种 Linux 版本；龙芯、MIPS 这类电脑说清楚用不了。 */
export function linuxNodeRuntimeArchitecture(architecture: string): NodeRuntimeArchitecture {
  if (architecture === 'x64' || architecture === 'arm64') return architecture
  throw new Error(`Node.js 官方只提供 Intel/AMD（x64）和 ARM（arm64）电脑的 Linux 版本，这台电脑的芯片（${architecture}）用不了，命令行工具也就装不上。可以先在星芒里直接聊天。`)
}

export function linuxNodeArchiveFileName(version: string, architecture: NodeRuntimeArchitecture): string {
  return `node-${version}-linux-${architecture}.tar.gz`
}

/** 压缩包里唯一的顶层目录名，也就是文件名去掉 .tar.gz。 */
export function linuxNodeArchiveTopDirectory(version: string, architecture: NodeRuntimeArchitecture): string {
  return `node-${version}-linux-${architecture}`
}

export function buildLinuxNodeExtractPlan(
  tarExecutable: string,
  archivePath: string,
  destination: string,
): LinuxNodeRuntimeProcess {
  if (!(linuxTarCandidates as readonly string[]).includes(tarExecutable)) {
    throw new Error('解压工具不是系统自带的那一份')
  }
  if (!path.posix.isAbsolute(archivePath) || !path.posix.isAbsolute(destination)) {
    throw new Error('Node.js 压缩包路径无效')
  }
  return {
    executable: tarExecutable,
    // --no-same-owner keeps every file owned by whoever extracts it, even if that is root.
    argv: ['-x', '-z', '--no-same-owner', '-f', archivePath, '-C', destination],
    timeoutMs: extractTimeoutMs,
  }
}

async function lstatOrNull(target: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.lstat(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function assertRegularFile(target: string, message: string): Promise<void> {
  const stats = await lstatOrNull(target)
  if (!stats || !stats.isFile() || stats.isSymbolicLink()) throw new Error(message)
}

/** 上次被打断（关机、强退）留下的暂存目录，下次准备前清掉，免得一直占着几十 MB。 */
async function removeStaleStagingDirectories(runtimeParent: string): Promise<void> {
  for (const entry of await fs.promises.readdir(runtimeParent, { withFileTypes: true })) {
    if (!entry.name.startsWith(stagingPrefix) || !entry.isDirectory()) continue
    await fs.promises.rm(path.join(runtimeParent, entry.name), { recursive: true, force: true })
  }
}

/**
 * 先把旧的挪进暂存目录再放新的，放不上就把旧的挪回去：Runtime/node 要么是完整的旧版，
 * 要么是完整的新版（I9 同理）。连挪回去也失败（同一目录里接连两次改名失败）时，旧版随
 * 暂存目录一起清掉，Runtime/node 空着，找 node 时退回电脑上原有的那份；再点一次「准备
 * Node.js」会重新下载。这是代下的官方包，丢了重下即可，不像 CLI 那样要保住现场。
 */
export async function replaceLinuxNodeRuntime(extracted: string, target: string, staging: string): Promise<void> {
  const previous = path.join(staging, 'previous')
  const existing = await lstatOrNull(target)
  if (existing) {
    assertPlainDirectory(target, 'linux')
    await fs.promises.rename(target, previous)
  }
  try {
    await fs.promises.rename(extracted, target)
  } catch (error) {
    if (existing) await fs.promises.rename(previous, target).catch(() => undefined)
    throw error
  }
}

type FailureStage = 'network' | 'verify'

async function installFromSource(
  source: NodeRuntimeDownloadSource,
  architecture: NodeRuntimeArchitecture,
  release: LinuxNodeRuntimeRelease,
  tarExecutable: string,
  staging: string,
  target: string,
  options: InstallLinuxNodeRuntimeOptions,
  fetchImplementation: typeof globalThis.fetch,
  runProcess: LinuxNodeRuntimeDependencies['runProcess'],
  stage: { current: FailureStage },
): Promise<void> {
  stage.current = 'network'
  const fileName = linuxNodeArchiveFileName(release.version, architecture)
  // 每个下载源一个子目录：前一个源失败留下的半截文件不会和这一次混在一起。
  const sourceDirectory = path.join(staging, source.id)
  await fs.promises.mkdir(sourceDirectory, { mode: 0o700 })
  const archivePath = path.join(sourceDirectory, fileName)
  report(options, {
    phase: 'downloading',
    source: source.id,
    message: `正在从${source.label}下载 Node.js ${release.version}`,
    percent: 0,
  })
  const download = await downloadNodeRuntimePackage(
    fetchImplementation,
    nodeRuntimeSourceUrl(source.baseUrl, `${release.version}/${fileName}`),
    archivePath,
    options,
    source,
  )

  stage.current = 'verify'
  report(options, { phase: 'verifying', source: source.id, message: '正在核对文件', percent: null })
  if (download.sha256 !== release.sha256) throw new Error('下载的 Node.js 压缩包和官方校验值对不上')

  report(options, { phase: 'installing', source: source.id, message: '正在解压 Node.js', percent: null })
  const extractDirectory = path.join(sourceDirectory, 'extract')
  await fs.promises.mkdir(extractDirectory, { mode: 0o700 })
  await runProcess(buildLinuxNodeExtractPlan(tarExecutable, archivePath, extractDirectory), options.signal)
  const topName = linuxNodeArchiveTopDirectory(release.version, architecture)
  const entries = await fs.promises.readdir(extractDirectory)
  if (entries.length !== 1 || entries[0] !== topName) throw new Error('Node.js 压缩包的内容和预期不一致')
  const extracted = path.join(extractDirectory, topName)
  assertPlainDirectory(extracted, 'linux')
  const nodeExecutable = path.join(extracted, 'bin', 'node')
  await assertRegularFile(nodeExecutable, 'Node.js 压缩包里没有可用的 node 程序')
  await assertRegularFile(
    path.join(extracted, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    'Node.js 压缩包里没有自带的 npm',
  )

  const versionResult = await runProcess(
    { executable: nodeExecutable, argv: ['--version'], timeoutMs: probeTimeoutMs },
    options.signal,
  )
  const version = versionResult.stdout.trim()
  if (version !== release.version || nodeVersionStatus(version) !== 'supported') {
    throw new Error('解压出来的 Node.js 版本和下载的不一致')
  }

  await replaceLinuxNodeRuntime(extracted, target, staging)
}

/**
 * 两个下载源都没成功时给客户看的那句话。只要每个源都是在核对之前就断的，多半是网络
 * 问题；文件对不上、解压失败属于另一类，不能说成网不好。
 */
export function linuxNodeRuntimeFailureMessage(
  failures: ReadonlyArray<{ stage: FailureStage; detail: string }>,
): string {
  const details = failures.map((failure) => failure.detail).join('；')
  const headline = failures.length > 0 && failures.every((failure) => failure.stage === 'network')
    ? 'Node.js 没有下载成功，可能是网络不稳，可以再点一次「准备 Node.js」。'
    : 'Node.js 没有准备好，可以再点一次「准备 Node.js」；还不行请联系客服。'
  return details ? `${headline}（${details}）` : headline
}

export async function installLinuxNodeRuntime(
  options: InstallLinuxNodeRuntimeOptions,
): Promise<NodeRuntimeInstallResult> {
  const dependencies: LinuxNodeRuntimeDependencies = { ...defaultDependencies, ...options.linux }
  let architecture: NodeRuntimeArchitecture
  try {
    architecture = linuxNodeRuntimeArchitecture(options.architecture ?? process.arch)
  } catch (error) {
    // 进度条要收到 error 这一步才会停下并显示原因，和下面每条失败路径一样。
    report(options, { phase: 'error', source: null, message: errorText(error), percent: null })
    throw error
  }
  const release = dependencies.pinnedRelease(architecture)
  const environment = options.environment ?? process.env
  const fetchImplementation = options.dependencies?.fetch ?? globalThis.fetch
  throwIfAborted(options.signal)
  const tarExecutable = dependencies.resolveTar()
  if (!tarExecutable) {
    const message = '这台电脑上找不到系统自带的解压工具，Node.js 没法准备。请联系客服。'
    report(options, { phase: 'error', source: null, message, percent: null })
    throw new Error(message)
  }

  const target = managedNodeRuntimeRoot(environment, 'linux')
  const runtimeParent = path.posix.dirname(target)
  const directoryOptions = { platform: 'linux' as const, env: environment }
  await ensureTrustedDirectory(managedProductRoot(environment, 'linux'), directoryOptions)
  await ensureTrustedDirectory(runtimeParent, directoryOptions)
  await removeStaleStagingDirectories(runtimeParent)
  // 暂存在产品目录里而不是 /tmp：有的电脑把 /tmp 设成不能运行程序，或者只给几百 MB。
  const staging = await fs.promises.mkdtemp(path.join(runtimeParent, stagingPrefix))
  await fs.promises.chmod(staging, 0o700)

  const failures: Array<{ stage: FailureStage; detail: string }> = []
  try {
    for (const source of nodeRuntimeDownloadSources(options.networkRegion)) {
      throwIfAborted(options.signal)
      const stage: { current: FailureStage } = { current: 'network' }
      try {
        await installFromSource(
          source,
          architecture,
          release,
          tarExecutable,
          staging,
          target,
          options,
          fetchImplementation,
          dependencies.runProcess,
          stage,
        )
        report(options, {
          phase: 'complete',
          source: source.id,
          message: `Node.js ${release.version} 准备好了`,
          percent: 100,
        })
        return {
          installed: true,
          action: 'installed',
          method: 'archive',
          source: source.id,
          version: release.version,
          architecture,
          // 这份 Node.js 的目录本软件自己补进 PATH，不改系统设置，也就没有要重开的东西。
          pathRefreshRequired: false,
          systemRestartRequired: false,
        }
      } catch (error) {
        if (options.signal?.aborted) throw error
        failures.push({ stage: stage.current, detail: `${source.label}：${errorText(error)}` })
        report(options, {
          phase: 'resolving',
          source: source.id,
          message: `${source.label}没有成功，正在换一个下载地址`,
          percent: null,
        })
      }
    }
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
  const message = linuxNodeRuntimeFailureMessage(failures)
  report(options, { phase: 'error', source: null, message, percent: null })
  throw new Error(message)
}

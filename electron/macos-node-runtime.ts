import fs from 'node:fs'
import path from 'node:path'
import {
  CommandRunnerError,
  runCommand,
  trustedCommandEnvironment,
  type CommandResult,
} from './command-runner'
import { darwinDeveloperIdVerificationArgv } from './macos-code-signing'
import { managedNodeRuntimeRoot, managedProductRoot } from './managed-cli-paths'
import {
  downloadNodeRuntimePackage,
  fetchNodeRuntimeText,
  nodeRuntimeDownloadSources,
  nodeRuntimeSourceUrl,
  normalizeNodeRuntimeArchitecture,
  parseNodeReleaseIndex,
  parseNodeShasums,
  type InstallNodeRuntimeOptions,
  type NodeRuntimeArchitecture,
  type NodeRuntimeDownloadSource,
  type NodeRuntimeInstallProgress,
  type NodeRuntimeInstallResult,
  type NodeRuntimeRelease,
} from './node-runtime'
import { assertPlainDirectory, ensureTrustedDirectory } from './trusted-temp'
import { nodeVersionStatus } from './versions'

/**
 * macOS 上缺 Node.js 时由本软件代为准备（第十六批 2，yoyo 2026-09-29 回「十六批都做」，
 * 推翻了第三批 10 的「Mac 只讲装法、不代装」）。
 *
 * 做法和四个命令行工具在 Mac 上的放法一样：不装进系统目录、不提权、不开终端，
 * 只把官方的 macOS 压缩包解到产品目录下的 Runtime/node。PATH 里这一份排在最后
 * （macos-platform.ts 的 darwinCommandPathCandidates），客户自己装过的永远优先。
 *
 * Trust chain, in order:
 * 1. The archive comes only from nodejs.org or npmmirror's fixed Node mirror, with
 *    redirects pinned to the same resource (node-runtime.ts fetchTrustedNodeResource).
 * 2. Its SHA-256 must match the one line for this exact file in SHASUMS256.txt.
 * 3. SHASUMS256.txt from a mirror is only as honest as the mirror, which is why the
 *    Windows MSI is additionally checked for its Authenticode publisher. The macOS
 *    counterpart is the Developer ID signature on bin/node, decided by codesign's exit
 *    status against a designated requirement pinned to the Node.js team identifier
 *    (macos-code-signing.ts explains why the printed text proves nothing).
 * 4. The extracted binary must report exactly the version that was selected.
 */

/** Apple Developer team that signs the official Node.js macOS binaries. */
export const nodeRuntimeDarwinTeamIdentifier = 'HX7739G8FX'

const stagingPrefix = 'node-staging-'
const extractTimeoutMs = 5 * 60_000
const probeTimeoutMs = 60_000

export interface DarwinNodeRuntimeProcess {
  executable: string
  argv: readonly string[]
  timeoutMs: number
}

export interface DarwinNodeRuntimeDependencies {
  runProcess(plan: DarwinNodeRuntimeProcess, signal?: AbortSignal): Promise<CommandResult>
}

export interface InstallDarwinNodeRuntimeOptions extends InstallNodeRuntimeOptions {
  /** 决定产品目录的环境变量（HOME）；缺省 process.env，测试用它指到临时目录。 */
  environment?: NodeJS.ProcessEnv
  darwin?: Partial<DarwinNodeRuntimeDependencies>
}

function defaultRunProcess(plan: DarwinNodeRuntimeProcess, signal?: AbortSignal): Promise<CommandResult> {
  return runCommand({ executable: plan.executable, argv: [...plan.argv] }, {
    env: trustedCommandEnvironment(process.env, undefined, 'darwin'),
    timeoutMs: plan.timeoutMs,
    maxOutputBytes: 2 * 1024 * 1024,
    signal,
  })
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

/** 压缩包里唯一的顶层目录名，也是 SHASUMS256.txt 里那一行去掉扩展名。 */
export function darwinNodeArchiveTopDirectory(version: string, architecture: NodeRuntimeArchitecture): string {
  return `node-${version}-darwin-${architecture}`
}

export function buildDarwinNodeExtractPlan(archivePath: string, destination: string): DarwinNodeRuntimeProcess {
  if (!path.posix.isAbsolute(archivePath) || !path.posix.isAbsolute(destination)) {
    throw new Error('Node.js 压缩包路径无效')
  }
  // /usr/bin/tar is bsdtar under SIP. By default it strips a leading "/" and
  // refuses entries containing "..", so the archive cannot write outside the
  // staging directory even before its digest is taken into account.
  return {
    executable: '/usr/bin/tar',
    argv: ['-xzf', archivePath, '-C', destination],
    timeoutMs: extractTimeoutMs,
  }
}

export function buildDarwinNodeSignaturePlan(nodeExecutable: string): DarwinNodeRuntimeProcess {
  return {
    executable: '/usr/bin/codesign',
    argv: darwinDeveloperIdVerificationArgv(nodeRuntimeDarwinTeamIdentifier, nodeExecutable),
    timeoutMs: probeTimeoutMs,
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
 * 解压出来的目录要换到 Runtime/node 上。先把旧的挪进暂存目录再放新的，放不上就把
 * 旧的挪回去：任何时候 Runtime/node 要么是完整的旧版，要么是完整的新版（I9 同理）。
 */
export async function replaceDarwinNodeRuntime(extracted: string, target: string, staging: string): Promise<void> {
  const previous = path.join(staging, 'previous')
  const existing = await lstatOrNull(target)
  if (existing) {
    assertPlainDirectory(target, 'darwin')
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
  staging: string,
  target: string,
  options: InstallDarwinNodeRuntimeOptions,
  fetchImplementation: typeof globalThis.fetch,
  runProcess: DarwinNodeRuntimeDependencies['runProcess'],
  stage: { current: FailureStage },
): Promise<NodeRuntimeRelease> {
  stage.current = 'network'
  report(options, {
    phase: 'resolving',
    source: source.id,
    message: `正在从${source.label}查询 Node.js 最新稳定版`,
    percent: null,
  })
  const index = await fetchNodeRuntimeText(
    fetchImplementation,
    nodeRuntimeSourceUrl(source.baseUrl, 'index.json'),
    'index',
    options.signal,
  )
  const release = parseNodeReleaseIndex(index, architecture, 'darwin-archive')
  if (!release) throw new Error(`${source.label}没有适合这台 Mac 的 Node.js 稳定版`)
  const checksums = await fetchNodeRuntimeText(
    fetchImplementation,
    nodeRuntimeSourceUrl(source.baseUrl, `${release.version}/SHASUMS256.txt`),
    'checksums',
    options.signal,
  )
  const expectedSha256 = parseNodeShasums(checksums, release.fileName)
  if (!expectedSha256) throw new Error(`${source.label}的校验清单里没有这个压缩包`)
  // 每个下载源一个子目录：前一个源失败留下的半截文件不会和这一次混在一起。
  const sourceDirectory = path.join(staging, source.id)
  await fs.promises.mkdir(sourceDirectory, { mode: 0o700 })
  const archivePath = path.join(sourceDirectory, release.fileName)
  report(options, {
    phase: 'downloading',
    source: source.id,
    message: `正在下载 Node.js ${release.version}`,
    percent: 0,
  })
  const download = await downloadNodeRuntimePackage(
    fetchImplementation,
    nodeRuntimeSourceUrl(source.baseUrl, `${release.version}/${release.fileName}`),
    archivePath,
    options,
    source,
  )

  stage.current = 'verify'
  report(options, { phase: 'verifying', source: source.id, message: '正在核对文件', percent: null })
  if (download.sha256 !== expectedSha256) throw new Error('下载的 Node.js 压缩包和官方校验值对不上')

  report(options, { phase: 'installing', source: source.id, message: '正在解压 Node.js', percent: null })
  const extractDirectory = path.join(sourceDirectory, 'extract')
  await fs.promises.mkdir(extractDirectory, { mode: 0o700 })
  await runProcess(buildDarwinNodeExtractPlan(archivePath, extractDirectory), options.signal)
  const topName = darwinNodeArchiveTopDirectory(release.version, architecture)
  const entries = await fs.promises.readdir(extractDirectory)
  if (entries.length !== 1 || entries[0] !== topName) throw new Error('Node.js 压缩包的内容和预期不一致')
  const extracted = path.join(extractDirectory, topName)
  assertPlainDirectory(extracted, 'darwin')
  const nodeExecutable = path.join(extracted, 'bin', 'node')
  await assertRegularFile(nodeExecutable, 'Node.js 压缩包里没有可用的 node 程序')
  await assertRegularFile(
    path.join(extracted, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    'Node.js 压缩包里没有自带的 npm',
  )

  report(options, { phase: 'verifying', source: source.id, message: '正在核对官方签名', percent: null })
  try {
    await runProcess(buildDarwinNodeSignaturePlan(nodeExecutable), options.signal)
  } catch (error) {
    if (error instanceof CommandRunnerError && error.exitCode !== null) {
      throw new Error('下载的 Node.js 没有通过官方签名核对，已停止使用')
    }
    throw error
  }
  const versionResult = await runProcess(
    { executable: nodeExecutable, argv: ['--version'], timeoutMs: probeTimeoutMs },
    options.signal,
  )
  const version = versionResult.stdout.trim()
  if (version !== release.version || nodeVersionStatus(version) !== 'supported') {
    throw new Error('解压出来的 Node.js 版本和下载的不一致')
  }

  await replaceDarwinNodeRuntime(extracted, target, staging)
  return release
}

/**
 * 两个下载源都没成功时给客户看的那句话。只要有一个源是在下载之前就断的（查不到版本、
 * 下不下来），多半是网络问题；文件对不上、签名不对属于另一类，不能说成网不好。
 */
export function darwinNodeRuntimeFailureMessage(
  failures: ReadonlyArray<{ stage: FailureStage; detail: string }>,
): string {
  const details = failures.map((failure) => failure.detail).join('；')
  const headline = failures.length > 0 && failures.every((failure) => failure.stage === 'network')
    ? 'Node.js 没有下载成功，可能是网络不稳，可以再点一次「准备 Node.js」。'
    : 'Node.js 没有准备好，可以再点一次「准备 Node.js」；还不行请联系客服。'
  return details ? `${headline}（${details}）` : headline
}

export async function installDarwinNodeRuntime(
  options: InstallDarwinNodeRuntimeOptions,
): Promise<NodeRuntimeInstallResult> {
  const architecture = normalizeNodeRuntimeArchitecture(options.architecture ?? process.arch)
  const environment = options.environment ?? process.env
  const fetchImplementation = options.dependencies?.fetch ?? globalThis.fetch
  const runProcess = options.darwin?.runProcess ?? defaultRunProcess
  throwIfAborted(options.signal)

  const target = managedNodeRuntimeRoot(environment, 'darwin')
  const runtimeParent = path.posix.dirname(target)
  const directoryOptions = { platform: 'darwin' as const, env: environment }
  await ensureTrustedDirectory(managedProductRoot(environment, 'darwin'), directoryOptions)
  await ensureTrustedDirectory(runtimeParent, directoryOptions)
  await removeStaleStagingDirectories(runtimeParent)
  const staging = await fs.promises.mkdtemp(path.join(runtimeParent, stagingPrefix))
  await fs.promises.chmod(staging, 0o700)

  const failures: Array<{ stage: FailureStage; detail: string }> = []
  try {
    for (const source of nodeRuntimeDownloadSources(options.networkRegion)) {
      throwIfAborted(options.signal)
      const stage: { current: FailureStage } = { current: 'network' }
      try {
        const release = await installFromSource(
          source,
          architecture,
          staging,
          target,
          options,
          fetchImplementation,
          runProcess,
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
  const message = darwinNodeRuntimeFailureMessage(failures)
  report(options, { phase: 'error', source: null, message, percent: null })
  throw new Error(message)
}

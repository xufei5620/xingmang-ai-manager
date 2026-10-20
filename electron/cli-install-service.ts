// 装和更新命令行工具（Claude Code、Codex、Grok）的那一整段（#1070 第 2 步，从 system-service.ts 的 createSystemService
// 原样搬来）：找 npm（Windows 上没有就先装 Node.js）、按网络挑源、下载卡住就换源、核对国内镜像下的包和 npm 官方源一致、
// 托管目录整体替换、Grok 的原生通道和 Mac / Linux 上的签名核对、装完 Claude Code 顺带装 Git、记更新历史，以及取消和清理
// 下了一半的东西。
//
// 各簇共用的那份在 system-service-context.ts；归首页检测、装运行时、Codex 型号名单那几块管的几样由 createSystemService
// 传进来（CliInstallServiceDependencies）。这里只 import system-service.ts 的类型：值要是也从那边拿，两个文件就互相
// require 了。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readBoundedUtf8File } from './bounded-file'
import { readBoundedResponseText } from './bounded-response'
import { cliCatalog, type ProviderId } from './catalog'
import {
  cliNativePackageMissingMessage,
  findMissingCliNativePackage,
  readPackageManifestVersion,
} from './cli-native-package'
import {
  cliPackageDirectory as cliPackageDirectoryFromNpmRoot,
  describeRunningCliProcessWarning,
  managedCliPackageDirectory,
  probeRunningCliProcesses,
} from './cli-process-probe'
import { buildCliUpdateRecord } from './cli-update-history'
import { resolveCliInstallVersion } from './cli-verified-versions'
import {
  commandEnvironment,
  isTrustedHighIntegrityExecutable,
  primeTrustedHighIntegrityExecutable,
  redactCommandText,
  trustedCommandEnvironment,
} from './command-runner'
import { errorCodeClause, type NpmFailurePart, npmFailureSentence, npmSourceFailure } from './failure-wording'
import type { GitRuntimeInstallProgress, GitRuntimeInstallResult } from './git-runtime-install'
import {
  cleanupDownloadedGrokBinary,
  type DownloadedGrokBinary,
  downloadLatestGrokBinary,
  installDownloadedGrokBinary,
} from './grok-installer'
import {
  type InstallCancellationHandle,
  type InstallCancellationOutcome,
  InstallCancelledError,
  isInstallCancelledError,
} from './install-cancellation'
import {
  buildInstallLeftoverLocations,
  type InstallLeftoverLocation,
  type InstallLeftoverSweepResult,
} from './install-leftovers'
import type { InstallProgressStage } from './ipc-contract'
import {
  runLinuxGrokPostInstallTransaction,
  verifyLinuxGrokPostInstall,
  type VerifyLinuxGrokPostInstallOptions,
} from './linux-grok'
import {
  ensureDarwinGrokAgentLink,
  inspectDarwinGrokVerifiedSelection,
  resolveDarwinGrokCanonicalSelection,
  runDarwinGrokPostInstallTransaction,
} from './macos-grok'
import { ensureManagedNpmLayout, type ManagedNpmLayout } from './managed-cli'
import { managedNpmCacheRoot } from './managed-cli-paths'
import { isRegisteredTrustedManagedWindowsPath } from './managed-path-trust'
import { officialRegistryUnreachableMarker } from './network-failure'
import { installNodeRuntime as installNodeRuntimeLts } from './node-runtime'
import {
  describeNpmCommandFailure,
  isMachineBoundNpmFailure,
  isNpmExitFailure,
  npmDownloadTimedOutMessage,
} from './npm-command-failure'
import { npmErrorCodesClause } from './npm-failure-reasons'
import {
  maximumNpmRegistryResponseBytes,
  npmInstallRegistries,
  npmLatestQueryTimeoutMs,
  npmMirrorRegistry,
  npmOfficialRegistry,
  npmPackageLatestUrl,
  npmPackageVersionUrl,
  npmRegistryLabel,
} from './npm-registry'
import { npmPrefixGlobalRoot, resolveSameUserNpmPrefix } from './npm-user-prefix'
import { grokInstallStrategyFor, platformCapabilitiesFor } from './platform-capabilities'
import { redactHomeDirectory } from './startup-log'
import { withSystemCertificateTrust } from './system-certificate-trust'
import type { NetworkRegion, NpmPackageReleaseMetadata, RendererMessageTarget, ToolStatus } from './system-service'
import { buildDarwinTrustedVerificationRunner, type ServiceContext } from './system-service-context'
import type { CliInstallation, CliInstallDisplaySource } from './tool-installation'
import { trustedInstallerCacheRoot } from './trusted-temp'
import { isExactCliVersion } from './versions'

const maximumNpmPackageLockBytes = 16 * 1024 * 1024

// 安装走到「把新版本换进全局目录」这一步就不能再中断了：半个目录被替换掉的
// CLI 既跑不起来也回不去。这两条是拒绝取消时给用户看的原因。
const managedPrefixSwapSealReason = '正在把新版本写入工具目录，这一步中断会让工具用不了，请等它结束。'
const grokBinarySwapSealReason = '正在替换 Grok CLI 可执行文件，这一步中断会让工具用不了，请等它结束。'
// Windows 上装完 Claude Code 接着顺带装 Git 的那一段接不上取消（第四十批 C），
// 用界面上别处「停不下来」时的同一句。
const gitAlongsideClaudeSealReason = '这一步已经不能取消了。'

/**
 * 本工具给 Claude Code / Codex / Gemini CLI 的安装、更新、回滚都走 npm。已经由官方
 * 安装器或别的方式装好的那份，npm 碰不到，只会在 npm 全局目录旁边再装一份，两份
 * 抢着被找到（#481）。这种情况不装，给一句怎么办。Grok 走自己的原生通道，不在此列。
 */
export function externalCliInstallRefusal(provider: ProviderId, installSource: CliInstallDisplaySource | undefined): string | null {
  if (provider === 'grok') return null
  const name = cliCatalog[provider].name
  if (installSource === 'native') return `这台电脑上的 ${name} 由官方安装器管理，这里不会再另装一份，请用它自己的方式更新`
  if (installSource === 'path') return `这台电脑上的 ${name} 不是通过本工具安装的，这里不会再另装一份，更新请用它原本的安装方式`
  return null
}

export interface InspectVerifiedDarwinGrokPostInstallOptions {
  homeDirectory: string
  expectedVersion: string
  runCommand: (
    spec: { executable: string; argv: readonly string[] },
  ) => Promise<{ stdout: string; stderr: string }>
}

/** Verifies and inspects only a private staged copy, then describes the bound canonical install. */
export async function inspectVerifiedDarwinGrokPostInstall(
  options: InspectVerifiedDarwinGrokPostInstallOptions,
): Promise<{ status: ToolStatus; installation: CliInstallation }> {
  const selection = resolveDarwinGrokCanonicalSelection(options.homeDirectory)
  // internal #16: the npm lifecycle script driving this install only ever
  // recreates the `grok` link on real hardware. Ensuring `agent` here — inside
  // the same post-install transaction — means a failure rolls back the whole
  // install exactly like a codesign or version mismatch would, instead of
  // quietly shipping an install this app's own automatic uninstall can't
  // later complete (see uninstallVerifiedDarwinGrokInstallation below).
  await ensureDarwinGrokAgentLink(options.homeDirectory, selection)
  return inspectDarwinGrokVerifiedSelection({
    homeDirectory: options.homeDirectory,
    selection,
    expectedVersion: options.expectedVersion,
    runCommand: options.runCommand,
    inspect: async (executablePath) => {
      const stats = await fs.promises.lstat(executablePath)
      if (
        !path.isAbsolute(executablePath)
        || executablePath === selection.executablePath
        || !stats.isFile()
        || stats.isSymbolicLink()
        || (stats.mode & 0o111) === 0
      ) {
        throw new Error('Grok postinstall inspection requires a private staged executable')
      }
      const installDirectory = fs.realpathSync(path.dirname(selection.canonicalLinkPath))
      return {
        status: {
          installed: true,
          version: options.expectedVersion,
          path: selection.executablePath,
          installDirectory,
        },
        installation: {
          commandPath: selection.canonicalLinkPath,
          installDirectory,
          packageRoot: null,
          npmPrefix: null,
          packageVersion: null,
          source: 'native',
        },
      }
    },
  })
}

/**
 * Linux 版拆分 ③：Linux 上没有 codesign，linux-grok.ts 改用「和 npm 官方源校验过的主程序包逐字节
 * 一致 + 报告的版本一致」来证明装的是 xAI 的那份，证明完了才在这里描述这次安装，和 macOS 那一份同形。
 */
export async function inspectVerifiedLinuxGrokPostInstall(
  options: VerifyLinuxGrokPostInstallOptions,
): Promise<{ status: ToolStatus; installation: CliInstallation }> {
  const selection = await verifyLinuxGrokPostInstall(options)
  const installDirectory = fs.realpathSync(path.dirname(selection.canonicalLinkPath))
  return {
    status: {
      installed: true,
      version: options.expectedVersion,
      path: selection.executablePath,
      installDirectory,
    },
    installation: {
      commandPath: selection.canonicalLinkPath,
      installDirectory,
      packageRoot: null,
      npmPrefix: null,
      packageVersion: null,
      source: 'native',
    },
  }
}

/**
 * The dependency graph must be resolved against the official registry, and a
 * mirror cannot stand in for it. Measured on Windows, all four managed CLIs
 * resolve only 7-12 packages in 1-4s on a healthy connection, so a wait long
 * enough to notice means the connection to registry.npmjs.org is struggling,
 * not that there is a lot of work to do. Ten minutes is a ceiling for that
 * case rather than an expected duration; five was killing connections that
 * were slow but still making progress. npm prints nothing throughout, which
 * is why this step used to look like a hang. A connection that delivers
 * nothing at all is ended sooner, by the same stall window as the download:
 * the packuments fetched here stream into the cache's temp files just like
 * tarballs do, so a slow resolution keeps the cache changing and only a dead
 * one stops it.
 */
export const npmResolutionTimeoutMs = 10 * 60_000
export const npmDownloadTimeoutMs = 5 * 60_000
export const npmResolutionHeartbeatMs = 15_000
/**
 * `npm ci` is where the package bytes move, and a fixed five minutes was not
 * enough of them: Claude Code and Codex are 90-160 MB per platform, so a link
 * under roughly 0.3-0.5 MB/s ran out of time mid-download, and the next
 * registry started again from zero because every attempt has its own cache.
 * npm never ends a transfer that is slow but still moving, so neither does
 * this step: it ends only once the attempt directory has stopped changing for
 * the stall window, and the ceiling is a backstop for a download that trickles
 * forever. The `--offline` install that follows still uses
 * npmDownloadTimeoutMs; it reads the verified cache and fetches nothing.
 */
export const npmDownloadStallTimeoutMs = 3 * 60_000
export const npmDownloadCeilingMs = 30 * 60_000
export const npmDownloadProgressCheckMs = 15_000
export const npmDownloadHeartbeatMs = 15_000
export const grokDownloadStallHeartbeatMs = 15_000

export function grokDownloadStallMessage(idleMs: number): string {
  return `Grok CLI 下载已 ${Math.round(idleMs / 1000)} 秒没有新数据，仍在等待；若长时间不动，请检查网络或切换加速线路后重试`
}

export function formatElapsedDuration(elapsedMs: number): string {
  const seconds = Math.max(0, Math.round(elapsedMs / 1000))
  if (seconds < 60) return `${seconds} 秒`
  return `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, '0')} 秒`
}

export function npmResolutionStartMessage(registry: string): string {
  return registry === npmOfficialRegistry
    ? '正在从 npm 官方源解析完整依赖图并校验 SHA-512 完整性。这一步必须直连官方源，'
      + '镜像无法代替；网络受限时可能较慢，但不影响后续下载速度，请耐心等待'
    : `正在从${npmRegistryLabel(registry)}解析完整依赖图，准备与官方 SHA-512 对账`
}

export function npmResolutionHeartbeatMessage(registry: string, elapsedMs: number): string {
  return `仍在解析${npmRegistryLabel(registry)}的依赖图…（已用时 ${formatElapsedDuration(elapsedMs)}）`
}

/**
 * npm 下载时也一声不出，网慢时这一步能下到 30 分钟（第三十七批 A），进度停在一句话上像卡死了。
 * 写法照解析那句，只报已用时：总量不知道，不猜百分比。两句是 2026-10-06 拍板的原话（第三十七批 D），
 * 「从」后面接 npm 时空一格，所以不拼 npmRegistryLabel。
 */
export function npmDownloadHeartbeatMessage(registry: string, elapsedMs: number): string {
  const source = registry === npmMirrorRegistry ? '从国内 npm 镜像' : '从 npm 官方源'
  return `仍在${source}下载…（已用时 ${formatElapsedDuration(elapsedMs)}）`
}

/**
 * Bytes under `directory`, counted without following links. Entries that vanish
 * mid-walk (npm moves a finished download out of its temp folder) are skipped.
 * A root that cannot be read rejects instead of counting as empty: a reading
 * that stays at zero would look exactly like a download that stopped moving.
 * The walk is sequential on purpose: it runs every few seconds next to the
 * download it watches and must not compete with it for the disk.
 */
export async function measureDirectoryBytes(directory: string): Promise<number> {
  let total = 0
  const pending = [directory]
  while (pending.length) {
    const current = pending.pop()
    if (current === undefined) break
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true })
    } catch (error) {
      if (current === directory) throw error
      continue
    }
    for (const entry of entries) {
      const child = path.join(current, entry.name)
      if (entry.isDirectory()) {
        pending.push(child)
      } else if (entry.isFile()) {
        try {
          total += (await fs.promises.lstat(child)).size
        } catch {
          // 量的这一刻刚被挪走或删掉：这次少算它，下一次再量。
        }
      }
    }
  }
  return total
}

export interface NpmDownloadStallWatch {
  /** Fires once the measured size has not changed for the stall window. */
  readonly signal: AbortSignal
  /** True once this watch ended the download, as opposed to the user's cancel or the ceiling. */
  readonly stalled: boolean
  /** The last size measured; null until the first measurement lands. */
  readonly bytes: number | null
  stop(): void
}

export interface NpmDownloadStallWatchOptions {
  checkIntervalMs?: number
  stallTimeoutMs?: number
  /** Monotonic milliseconds: a wall-clock correction must never read as a stall. */
  now?: () => number
}

/**
 * The size of the attempt directory is the progress report npm never prints:
 * make-fetch-happen tees every response into cacache, which appends to a temp
 * file as chunks arrive, while tar unpacks into node_modules as it reads. Any
 * change counts, a shrink included, since npm discarding a broken partial
 * download before its own retry is activity rather than a hang. A measurement
 * that fails counts as activity too: a download is never ended on evidence the
 * watch could not collect.
 */
export function createNpmDownloadStallWatch(
  measureBytes: () => Promise<number>,
  options: NpmDownloadStallWatchOptions = {},
): NpmDownloadStallWatch {
  const checkIntervalMs = options.checkIntervalMs ?? npmDownloadProgressCheckMs
  const stallTimeoutMs = options.stallTimeoutMs ?? npmDownloadStallTimeoutMs
  const now = options.now ?? (() => performance.now())
  const controller = new AbortController()
  let lastBytes: number | null = null
  let lastChangeAt = now()
  let measuring = false
  let stopped = false
  let stalled = false
  const timer = setInterval(() => { void check() }, checkIntervalMs)

  function stop(): void {
    if (stopped) return
    stopped = true
    clearInterval(timer)
  }

  async function check(): Promise<void> {
    // 上一次还没量完（盘慢、文件多）就跳过这一拍，不叠着量。
    if (measuring || stopped) return
    measuring = true
    let bytes: number | null
    try {
      bytes = await measureBytes()
    } catch {
      bytes = null
    } finally {
      measuring = false
    }
    if (stopped) return
    const checkedAt = now()
    if (bytes === null || bytes !== lastBytes) {
      if (bytes !== null) lastBytes = bytes
      lastChangeAt = checkedAt
      return
    }
    if (checkedAt - lastChangeAt < stallTimeoutMs) return
    stalled = true
    stop()
    controller.abort(new Error(npmDownloadTimedOutMessage))
  }

  void check()
  return {
    signal: controller.signal,
    get stalled() { return stalled },
    get bytes() { return lastBytes },
    stop,
  }
}

export function parseNpmPackageReleaseMetadata(
  input: string,
  expectedPackageName: string,
): NpmPackageReleaseMetadata | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(input) as unknown
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const dist = record.dist && typeof record.dist === 'object' && !Array.isArray(record.dist)
    ? record.dist as Record<string, unknown>
    : null
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  const version = typeof record.version === 'string' ? record.version.trim() : ''
  const integrity = typeof dist?.integrity === 'string' ? dist.integrity.trim() : ''
  if (name !== expectedPackageName || !isExactCliVersion(version)) return null
  const match = integrity.match(/^sha512-([A-Za-z0-9+/]+={0,2})$/)
  if (!match) return null
  try {
    if (Buffer.from(match[1], 'base64').length !== 64) return null
  } catch {
    return null
  }
  return { name, version, integrity }
}

export async function fetchNpmPackageReleaseMetadata(
  registry: string,
  packageName: string,
  version: string | 'latest',
  fetchImplementation: typeof fetch = fetch,
  timeoutMs = npmLatestQueryTimeoutMs,
): Promise<NpmPackageReleaseMetadata> {
  const sourceLabel = registry === npmMirrorRegistry ? '国内 npm 镜像' : 'npm 官方源'
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  timeout.unref?.()
  try {
    const endpoint = version === 'latest'
      ? npmPackageLatestUrl(registry, packageName)
      : npmPackageVersionUrl(registry, packageName, version)
    const response = await fetchImplementation(endpoint, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`${sourceLabel} HTTP ${response.status}`)
    const body = await readBoundedResponseText(
      response,
      maximumNpmRegistryResponseBytes,
      `${sourceLabel}包元数据`,
    )
    const release = parseNpmPackageReleaseMetadata(body, packageName)
    if (!release || (version !== 'latest' && release.version !== version)) {
      throw new Error(`${sourceLabel}返回的包名、版本或 SHA-512 完整性元数据无效`)
    }
    return release
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`${sourceLabel}包元数据查询超时`)
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

/** Binds registry metadata to the exact direct package record npm resolved from the official registry. */
export function assertNpmReleaseMatchesOfficialLock(
  trustedRelease: NpmPackageReleaseMetadata,
  officialLock: string,
): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(officialLock) as unknown
  } catch {
    throw new Error('npm 官方 package-lock.json 不是有效 JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('npm 官方 package-lock.json 根结构无效')
  }
  const packages = (parsed as Record<string, unknown>).packages
  if (!packages || typeof packages !== 'object' || Array.isArray(packages)) {
    throw new Error('npm 官方 package-lock.json 缺少 packages 图')
  }
  const packageEntries = packages as Record<string, unknown>
  const root = packageEntries['']
  const rootDependencies = root && typeof root === 'object' && !Array.isArray(root)
    ? (root as Record<string, unknown>).dependencies
    : null
  const directVersion = rootDependencies && typeof rootDependencies === 'object' && !Array.isArray(rootDependencies)
    ? (rootDependencies as Record<string, unknown>)[trustedRelease.name]
    : null
  const directLocation = `node_modules/${trustedRelease.name}`
  const directEntry = packageEntries[directLocation]
  if (
    directVersion !== trustedRelease.version
    || !directEntry
    || typeof directEntry !== 'object'
    || Array.isArray(directEntry)
  ) {
    throw new Error('npm 官方 package-lock.json 的目标直依赖身份或版本与发布元数据不一致')
  }
  const record = directEntry as Record<string, unknown>
  if (
    record.version !== trustedRelease.version
    || record.integrity !== trustedRelease.integrity
  ) {
    throw new Error('npm 官方 package-lock.json 的目标直依赖版本或 SHA-512 与发布元数据不一致')
  }
}

function canonicalNpmPackageLock(
  input: string,
  packageName: string,
  version: string,
): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(input) as unknown
  } catch {
    throw new Error('npm package-lock.json 不是有效 JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('npm package-lock.json 根结构无效')
  }
  const lock = parsed as Record<string, unknown>
  const packages = lock.packages
  if (!packages || typeof packages !== 'object' || Array.isArray(packages)) {
    throw new Error('npm package-lock.json 缺少 packages 图')
  }
  const packageEntries = packages as Record<string, unknown>
  const root = packageEntries['']
  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    throw new Error('npm package-lock.json 缺少根包')
  }
  const rootDependencies = (root as Record<string, unknown>).dependencies
  if (
    !rootDependencies
    || typeof rootDependencies !== 'object'
    || Array.isArray(rootDependencies)
    || (rootDependencies as Record<string, unknown>)[packageName] !== version
  ) {
    throw new Error('npm package-lock.json 没有锁定目标 CLI 的精确版本')
  }
  for (const [location, entry] of Object.entries(packageEntries)) {
    if (!location) continue
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`npm package-lock.json 包记录无效：${location}`)
    }
    const record = entry as Record<string, unknown>
    const entryVersion = typeof record.version === 'string' ? record.version.trim() : ''
    const integrity = typeof record.integrity === 'string' ? record.integrity.trim() : ''
    const integrityMatch = integrity.match(/^sha512-([A-Za-z0-9+/]+={0,2})$/)
    if (!isExactCliVersion(entryVersion) || !integrityMatch) {
      throw new Error(`npm package-lock.json 包版本或 SHA-512 无效：${location}`)
    }
    if (Buffer.from(integrityMatch[1], 'base64').length !== 64) {
      throw new Error(`npm package-lock.json SHA-512 长度无效：${location}`)
    }
  }

  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'resolved')
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]))
  }
  return JSON.stringify(canonicalize(lock))
}

export function assertNpmPackageLocksEquivalent(
  officialLock: string,
  candidateLock: string,
  packageName: string,
  version: string,
): void {
  const official = canonicalNpmPackageLock(officialLock, packageName, version)
  const candidate = canonicalNpmPackageLock(candidateLock, packageName, version)
  if (candidate !== official) {
    throw new Error('npm 镜像的完整依赖图、版本或 SHA-512 与官方源不一致')
  }
}

export class ManagedNpmRollbackError extends Error {
  readonly preserveTransaction = true

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ManagedNpmRollbackError'
  }
}

export interface ManagedNpmReplaceOperations {
  rename(source: string, destination: string): Promise<void>
}

export interface ManagedNpmReplaceResult {
  /**
   * 检查通过后，旧版那份是否已改名成 superseded-prefix。false 时它还叫 previous-prefix：
   * 收尾删除没做完的话，下次安装开头的恢复仍会把它当成「更新没做完」退回去，和以前一样。
   */
  backupRetired: boolean
}

const managedNpmBackupRetireAttempts = 5

function isTransientManagedNpmRenameError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY' || code === 'EAGAIN'
}

/**
 * 新版检查通过以后，previous-prefix 就不该再是「断了要退回的那份」。下次装、更新、卸载开头的
 * 恢复（managed-cli.ts）只认这个名字：「完成」之后、临时文件夹删完之前退出、关机、崩掉，或者
 * 删到一半失败，以前都会被它当成更新没做完，把检查过的新版换回旧版，删了一半的话换回来的
 * 还是残缺的旧版。同一个目录里改名一步完成，所以不另写记号文件：删到一半时记号可能先没了、
 * 备份还在。安全软件正攥着里面的文件时照 safe-local-data.ts 的规矩重试几次；还不行就留着
 * 原名，和以前一样，不影响这次报完成。
 */
async function retireVerifiedManagedNpmBackup(
  backup: string,
  superseded: string,
  operations: ManagedNpmReplaceOperations,
): Promise<boolean> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await operations.rename(backup, superseded)
      return true
    } catch (error) {
      if (!isTransientManagedNpmRenameError(error) || attempt === managedNpmBackupRetireAttempts - 1) return false
    }
    await new Promise((resolve) => setTimeout(resolve, 20 * (2 ** attempt)))
  }
}

export async function replaceManagedNpmPrefixAtomically(
  activePrefix: string,
  stagedPrefix: string,
  transactionDirectory: string,
  verifyPromotedPrefix: () => Promise<void>,
  operations: ManagedNpmReplaceOperations = fs.promises,
): Promise<ManagedNpmReplaceResult> {
  const active = path.resolve(activePrefix)
  const staged = path.resolve(stagedPrefix)
  const transaction = path.resolve(transactionDirectory)
  const relativeStage = path.relative(transaction, staged)
  if (
    active === staged
    || path.parse(active).root.toLowerCase() !== path.parse(staged).root.toLowerCase()
    || relativeStage === ''
    || relativeStage === '..'
    || relativeStage.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeStage)
  ) {
    throw new Error('托管 npm 事务目录无效，未修改当前安装')
  }
  if (!fs.existsSync(active) || !fs.statSync(active).isDirectory()) {
    throw new Error('当前托管 npm 目录不存在，无法执行原子更新')
  }
  if (!fs.existsSync(staged) || !fs.statSync(staged).isDirectory()) {
    throw new Error('暂存 npm 目录不存在，无法执行原子更新')
  }

  const backup = path.join(transaction, 'previous-prefix')
  const rejected = path.join(transaction, 'rejected-prefix')
  await operations.rename(active, backup)
  let promoted = false
  try {
    await operations.rename(staged, active)
    promoted = true
    await verifyPromotedPrefix()
  } catch (error) {
    let rollbackError: unknown = null
    try {
      if (promoted && fs.existsSync(active)) await operations.rename(active, rejected)
      if (fs.existsSync(backup)) await operations.rename(backup, active)
    } catch (cause) {
      rollbackError = cause
    }
    if (rollbackError) {
      const detail = rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
      // 上屏只说结果和下一步，「回滚失败」四个字留着：渲染层靠它不盖安抚文案（operation-error.ts 的 undoFailed）。
      // 原话连同新版没装上的那个原因挂在 cause 上进运行日志（#1100 第1条）。
      throw new ManagedNpmRollbackError(
        `这次更新没装上，旧版本回滚失败，工具现在可能打不开。到首页再装一次；还不行请找客服${errorCodeClause(rollbackError)}。`,
        { cause: new Error(`托管 npm 更新失败，且旧版本回滚失败：${detail}`, { cause: error }) },
      )
    }
    throw error
  }
  return {
    backupRetired: await retireVerifiedManagedNpmBackup(backup, path.join(transaction, 'superseded-prefix'), operations),
  }
}

export interface CliMaintenancePlan {
  kind: 'npm-install'
  executable: string
  argv: string[]
  windowsPackageManager: 'npm'
}

export interface CliInstallReleaseOptions {
  /** 要安装的版本,'latest' 表示不钉版本。 */
  version?: string
  fetchNpmRelease: (
    registry: string,
    packageName: string,
    version: string | 'latest',
  ) => Promise<NpmPackageReleaseMetadata>
}

/**
 * Selects the authoritative release before generating an npm dependency lock. Grok on macOS
 * and Linux comes from npm like the other tools: its npm latest follows xAI's stable channel
 * (docs/CLI-VERIFIED-VERSIONS.md), and x.ai itself is mostly unreachable from China, so it is
 * not asked first (yoyo 2026-10-14). fetchNpmRelease itself refuses a pinned version npm
 * answers with another one.
 */
export async function resolveCliInstallRelease(
  provider: ProviderId,
  options: CliInstallReleaseOptions = { fetchNpmRelease: fetchNpmPackageReleaseMetadata },
): Promise<NpmPackageReleaseMetadata> {
  return options.fetchNpmRelease(
    npmOfficialRegistry,
    cliCatalog[provider].packageName,
    options.version ?? 'latest',
  )
}

/**
 * npm 12 起依赖的安装脚本默认不跑，要按包放行；npm 11 及更早只认「不许跑」，放行名单对它们
 * 不起作用，照旧全跑。所以这里只列离了安装脚本就装不全、或装出来会变样的包，npm 12 下其余的
 * 照样挡着：Gemini 带的 node-pty 是现场编译，Gemini 先用自带预编译的 @lydell/node-pty，
 * 用不着它。主程序包钉死在这次要装的版本上；npm 按下载地址认包名和版本，不信包里自报的。
 */
export function buildCliInstallScriptAllowlist(provider: ProviderId, version: string): string[] {
  switch (provider) {
    case 'claude':
    case 'grok':
      // postinstall 把平台主程序放进 bin/（Claude）或解到 ~/.grok/bin（Grok）。不跑的话
      // Claude 只剩一个 500 字节的占位脚本，Grok 什么都没装上。
      return [`${cliCatalog[provider].packageName}@${version}`]
    case 'gemini':
      // keytar 的安装脚本只是把包里带的预编译文件拷进 build/Release。不跑的话 Gemini 退回
      // 把凭据存成文件（0.62.0 的 FileKeychain），原先存进系统钥匙串的它就读不到了。
      return ['@github/keytar']
    case 'codex':
      return []
  }
}

export interface CliResolutionManifest {
  name: string
  version: string
  private: true
  dependencies: Record<string, string>
  allowScripts?: Record<string, boolean>
}

/**
 * 解析依赖图、下载校验，以及 Grok 的正式安装都在放这份清单的目录里跑。Grok 那一步是
 * `npm ci` 不是全局安装，npm 12 不许在命令行放行安装脚本（报 EALLOWSCRIPTS），只认清单里的
 * allowScripts；其余三家全局安装时 npm 不读这份清单，放行写在命令行上。
 */
export function buildCliResolutionManifest(provider: ProviderId, version: string): CliResolutionManifest {
  const manifest: CliResolutionManifest = {
    name: 'xingmang-cli-resolution',
    version: '1.0.0',
    private: true,
    dependencies: { [cliCatalog[provider].packageName]: version },
  }
  if (provider === 'grok') {
    manifest.allowScripts = Object.fromEntries(
      buildCliInstallScriptAllowlist(provider, version).map((spec) => [spec, true]),
    )
  }
  return manifest
}

export function buildCliMaintenancePlan(
  provider: ProviderId,
  npmExecutable: string | null,
  npmPrefix: string | null = null,
  version = 'latest',
  verifiedLifecycleScripts = false,
  platform: NodeJS.Platform = process.platform,
): CliMaintenancePlan {
  if (provider === 'grok') {
    const strategy = grokInstallStrategyFor(platform)
    if (strategy === 'windows-native') {
      throw new Error('Grok CLI 必须使用 xAI 已签名二进制安装器')
    }
    if (strategy === 'external') {
      throw new Error('当前平台不支持 Grok CLI 一键安装')
    }
    if (!verifiedLifecycleScripts) {
      throw new Error('Grok CLI 生命周期脚本必须先通过完整性校验')
    }
  }
  if (!npmExecutable) throw new Error('未检测到 npm，请先安装 Node.js')
  if (platform !== 'win32' && provider !== 'grok' && !npmPrefix) {
    throw new Error(platform === 'darwin' ? 'macOS 用户级 npm 前缀不能为空' : '用户级 npm 前缀不能为空')
  }
  if (version !== 'latest' && !isExactCliVersion(version)) {
    throw new Error('npm CLI 版本号格式无效')
  }
  if (provider === 'grok') {
    return {
      kind: 'npm-install',
      executable: npmExecutable,
      argv: ['ci', '--omit=dev'],
      windowsPackageManager: 'npm',
    }
  }
  const allowedScripts = verifiedLifecycleScripts ? buildCliInstallScriptAllowlist(provider, version) : []
  return {
    kind: 'npm-install',
    executable: npmExecutable,
    argv: [
      'install',
      '--global',
      ...(npmPrefix ? [`--prefix=${npmPrefix}`] : []),
      ...(!verifiedLifecycleScripts ? ['--ignore-scripts'] : []),
      ...(allowedScripts.length > 0 ? [`--allow-scripts=${allowedScripts.join(',')}`] : []),
      '--omit=dev',
      '--package-lock=false',
      `${cliCatalog[provider].packageName}@${version}`,
    ],
    windowsPackageManager: 'npm',
  }
}

// `describeProbeFailure` (probe-failure.ts) and the `build*FromSettled`
// helpers below keep a rejected probe from masquerading as "not installed".
/**
 * 装 Claude Code 时顺带把缺的 Git 装上（协调者 2026-09-24：能自动的就不让客户点）。
 * Git 只是可选环境，它装不上**不能**让已经装好的 Claude Code 报失败：这里吞掉错误，
 * 只留一句中文说明，首页运行环境那行的「安装 Git」按钮照旧在，客户想重试点它就行。
 */
export async function installGitAlongsideClaude(
  install: () => Promise<{ action: GitRuntimeInstallResult['action'] }>,
  note: (message: string) => void,
): Promise<void> {
  try {
    const result = await install()
    if (result.action === 'installed') note('Git 也顺带装好了')
  } catch {
    note('Git 这次没装上，不影响使用 Claude Code；以后可以在首页「运行环境」里点「安装 Git」再试')
  }
}

/**
 * Windows 上装 Claude Code 时，顺带的 Git（installGitAlongsideClaude）是在 Claude Code 那一项出队之后
 * 才装的，界面上却仍是同一次「安装」，那一行的「取消」也还亮着。装 Git 接不上取消，所以这次安装的取消
 * 句柄先不收、改成封住：这时点「取消」回「这一步已经不能取消了。」，而不是「这个工具当前没有正在进行的
 * 安装。」（第四十批 C）。Git 那段结束（装上、没装上都算）再收。Claude Code 自己没装成（失败或被取消）
 * 就不进 Git 这段，照旧马上收。
 */
export async function finishClaudeInstallWithGit(
  claude: Promise<void>,
  cancellation: InstallCancellationHandle,
  installGit: () => Promise<void>,
): Promise<void> {
  try {
    await claude
    cancellation.seal(gitAlongsideClaudeSealReason)
    await installGit()
  } finally {
    cancellation.release()
  }
}

/** 装命令行工具要用、但归首页检测、装运行时、Codex 型号名单那几块管的几样，由 createSystemService 传进来。 */
export interface CliInstallServiceDependencies {
  inspectNetworkRegion: () => Promise<NetworkRegion>
  withToolCertificateHint: (message: string, raw?: string) => Promise<string>
  inspectCliTool: (
    provider: ProviderId,
    npmExecutable?: string | null,
    npmGlobalRoot?: string | null,
    executablePath?: string | null,
  ) => Promise<{ status: ToolStatus; installation: CliInstallation | null }>
  invalidateCliUpdateCache: (provider: ProviderId) => void
  installGitRuntime: (
    target: RendererMessageTarget,
    onProgress?: (progress: GitRuntimeInstallProgress) => void,
  ) => Promise<GitRuntimeInstallResult>
  /** 装完 Codex 时调：换上的新版读不进随包的型号名单，就把写进去的那份收回。 */
  takeBackUnreadableCodexModelCatalog: (trigger: 'cli-installed') => Promise<void>
}

export function createCliInstallService(context: ServiceContext, dependencies: CliInstallServiceDependencies) {
  const {
    store, serviceOptions, windowsExecutionMode, platform, providerRoots, runtimeLog, cliUpdateHistory,
    findExecutableForService, executeCommand, downloadFetch, registryMetadataFetch, resolveSubprocessProxyEnvironment,
    withoutDeadLoopbackProxies, acceleratedDownloadCount, withDownloadAcceleration, grokBucketDownloads,
    installing, installationQueue, installCancellations, installRequestedVersions, nodeRuntimeInstall,
    createInstallTemporaryDirectory, assertInstallDiskSpace,
    findInstalledExecutable, preferredNodeDirectories, resolveServiceNpmGlobalRoot,
    isManagedNpmInstallation, cliTerminalAccess, describeOccupiedCliFailure,
  } = context
  const {
    inspectNetworkRegion,
    withToolCertificateHint,
    inspectCliTool,
    invalidateCliUpdateCache,
    installGitRuntime,
    takeBackUnreadableCodexModelCatalog,
  } = dependencies

  function sendInstallProgress(
    target: RendererMessageTarget,
    provider: ProviderId,
    state: 'started' | 'output' | 'success' | 'error',
    message: string,
    percent?: number,
    staged?: { stage: InstallProgressStage; elapsedMs?: number },
  ): void {
    // 界面只按阶段显示白话，原话（源名、SHA-512、包名、网址、npm 自己的英文）
    // 客服排查还要看，所以落进运行日志。心跳和下载百分比每隔几秒一条，不记。
    if (staged && staged.elapsedMs === undefined && percent === undefined) {
      runtimeLog?.log('info', 'install', staged.stage === 'raw-output' ? 'cli.install.output' : 'cli.install.progress', message, {
        provider,
        stage: staged.stage,
      })
    }
    if (!target.isDestroyed()) {
      target.send('cli:install-progress', {
        provider,
        state,
        message,
        percent,
        ...(staged ? { stage: staged.stage } : {}),
        ...(staged?.elapsedMs !== undefined ? { elapsedMs: staged.elapsedMs } : {}),
      })
    }
  }

  async function findNpmForCliInstall(
    provider: ProviderId,
    target: RendererMessageTarget,
    nodeDirectories: readonly string[],
  ): Promise<string | null> {
    if (process.platform !== 'win32') {
      return findExecutableForService('npm', {
        env: commandEnvironment(),
        windowsPackageManagers: ['npm'],
        ...(nodeDirectories.length ? { additionalPaths: nodeDirectories } : {}),
      })
    }

    const trustedOnly = windowsExecutionMode === 'trusted-only'
    const findUsableNpm = () => findExecutableForService('npm', {
      env: trustedOnly ? trustedCommandEnvironment() : commandEnvironment(),
      windowsPackageManagers: ['npm'],
      trustedOnly,
    })
    let npmExecutable = await findUsableNpm()
    if (npmExecutable) return npmExecutable

    const detectedNpm = await findInstalledExecutable('npm')
    if (detectedNpm) {
      if (trustedOnly) await primeTrustedHighIntegrityExecutable(detectedNpm, platform)
      if (!trustedOnly || isTrustedHighIntegrityExecutable(detectedNpm)) return detectedNpm
      throw new Error(
        `已检测到 npm（${detectedNpm}），但当前会话经过了显式提权或权限状态无法确认，不能安全执行该路径。请以普通权限启动本程序，或将 Node.js 安装到受保护的系统目录后重试`,
      )
    }

    sendInstallProgress(
      target,
      provider,
      'output',
      `未检测到${trustedOnly ? '系统级' : '可用的'} Node.js/npm，正在自动安装 Node.js LTS`,
    )
    if (nodeRuntimeInstall.running) throw new Error('Node.js 正在安装中，请等待当前任务完成')
    nodeRuntimeInstall.running = true
    try {
      await installNodeRuntimeLts({
        networkRegion: await inspectNetworkRegion(),
        temporaryDirectoryMode: windowsExecutionMode,
        dependencies: { fetch: downloadFetch },
        onProgress: (progress) => {
          if (progress.message) sendInstallProgress(target, provider, 'output', progress.message)
        },
      })
    } finally {
      nodeRuntimeInstall.running = false
    }
    npmExecutable = await findUsableNpm()
    if (!npmExecutable) {
      throw new Error('Node.js 安装完成后仍未检测到可用的 npm，请重启本程序后再试')
    }
    return npmExecutable
  }

  /**
   * 安装整段都包在临时加速里：Node.js LTS 与 npm 下载共用同一条线路，中途不换代理
   * （换代理会让已建立的连接和重试落到两条线路上）。Windows 上的 Grok 例外：先从星芒
   * 存储桶下，国内直连，只有去 xAI 那一路才接加速（runCliInstall 里交给 grok-installer.ts）。
   */
  async function installCliOperation(
    provider: ProviderId,
    target: RendererMessageTarget,
    requestedVersion?: string,
    cancellation?: InstallCancellationHandle,
  ): Promise<void> {
    // 已经在装、排队期间被取消、或磁盘根本不够的，一条线路都不要起。
    if (installing.has(provider)) throw new Error(`${cliCatalog[provider].name} 正在安装中`)
    cancellation?.throwIfCancelled()
    await assertNpmChannelOwnsCli(provider)
    // 磁盘快满时 npm 会跑到一半才报 ENOSPC：用户白等几分钟，旧版本还可能已经被
    // 动过。所以一个字节都还没下之前先看一眼盘（读不到空间照常放行）。
    await assertInstallDiskSpace(`${cliCatalog[provider].name} 安装失败`)
    try {
      if (provider === 'grok' && grokInstallStrategyFor(platform) === 'windows-native') {
        await runCliInstall(provider, target, requestedVersion, cancellation)
      } else {
        await withDownloadAcceleration(
          (message) => sendInstallProgress(target, provider, 'output', message),
          () => runCliInstall(provider, target, requestedVersion, cancellation),
        )
      }
    } finally {
      // 命令行可能换了版本（更新、退回，装到一半回滚没回干净的也算）：读不进型号名单的话
      // Codex 起不来。趁还没出队就收回，排在后面的那次打开才不会先撞上。
      if (provider === 'codex') await takeBackUnreadableCodexModelCatalog('cli-installed')
    }
  }

  /**
   * 按首页同一套判定（同一个 npm 全局根）看现在装着的是哪一份。探测本身失败时不拦：
   * 那时装没装都没有结论，界面给的是「重新检测」，不会走到这里。
   */
  async function assertNpmChannelOwnsCli(provider: ProviderId): Promise<void> {
    if (provider === 'grok') return
    let installSource: CliInstallDisplaySource | undefined
    try {
      // 同 inspectCliUpdate：这里只用得上 npm 在哪，不为它的版本号多起一次 `npm --version`。
      const npmPath = await findInstalledExecutable('npm')
      const npmGlobalRoot = await resolveServiceNpmGlobalRoot(npmPath)
      installSource = (await inspectCliTool(provider, npmPath, npmGlobalRoot)).status.installSource
    } catch {
      return
    }
    const refusal = externalCliInstallRefusal(provider, installSource)
    if (refusal) throw new Error(refusal)
  }

  async function readInstalledCliVersion(provider: ProviderId): Promise<string | null> {
    try {
      return (await inspectCliTool(provider, null, null)).status.version ?? null
    } catch {
      return null
    }
  }

  async function recordCliUpdate(
    provider: ProviderId,
    from: string | null,
    to: string | null,
    requested: boolean,
  ): Promise<void> {
    const updateRecord = buildCliUpdateRecord(from, to, requested, Date.now())
    if (!updateRecord) return
    // 记录只决定首页能不能「退回更新前的版本」,写不进去不该让一次已经
    // 成功的更新报失败。
    await cliUpdateHistory.record(provider, updateRecord).catch((error: unknown) => {
      runtimeLog?.log('warn', 'install', 'cli.update-history.write-failed', `${cliCatalog[provider].name} 更新记录没有写入`, {
        provider,
        detail: error instanceof Error ? redactHomeDirectory(error.message, providerRoots.userHome) : '未知错误',
      })
    })
  }

  async function runCliInstall(
    provider: ProviderId,
    target: RendererMessageTarget,
    requestedVersion?: string,
    cancellation?: InstallCancellationHandle,
  ): Promise<void> {
    const grokInstallStrategy = provider === 'grok' ? grokInstallStrategyFor(platform) : null
    if (installing.has(provider)) throw new Error(`${cliCatalog[provider].name} 正在安装中`)
    // 排队等待期间点的取消在这里生效:队列把任务交给我们时才发现已经取消,
    // 直接退出,一条 npm 命令都不要起。
    cancellation?.throwIfCancelled()
    const definition = cliCatalog[provider]
    installing.add(provider)
    let downloadedGrokBinary: DownloadedGrokBinary | null = null
    let managedNpmLayout: ManagedNpmLayout | null = null
    let managedNpmTransaction: string | null = null
    let preserveManagedNpmTransaction = false
    let occupancyProbeRoot: string | null = null
    let updatingExistingInstall = false
    let versionBeforeUpdate: string | null = null
    try {
      // 装哪个版本由主进程决定:调用方点名(回滚)优先,其次看设置里的
      // 「总是安装最新版」,再次才是名单里的推荐版本。名单为空的工具落回
      // latest,行为与从前一致。Grok 在 Windows 上以 xAI stable 为上限(先看存储桶里同步的那份);
      // macOS、Linux 上和另外三家一样只认 npm（cliLatestVersionSource）。
      const versionChoice = resolveCliInstallVersion(provider, {
        requested: requestedVersion,
        alwaysLatest: store.read().alwaysInstallLatestCli === true,
      })
      if (provider === 'grok') {
        // Grok 不走下面按 npm 目录读 package.json 的那一套,更新前的版本只能问它自己。
        // 读不出来就不记这一笔,「退回」只是不出现,不影响这次更新。
        versionBeforeUpdate = await readInstalledCliVersion(provider)
        if (grokInstallStrategy === 'external') {
          throw new Error('当前平台不支持 Grok CLI 一键安装')
        }
        if (grokInstallStrategy === 'windows-native') {
          const sameUserInstall = windowsExecutionMode === 'same-user'
          const installedBefore = await findInstalledExecutable(definition.command)
          sendInstallProgress(
            target,
            provider,
            'started',
            `正在从 xAI 官方下载并验证已签名的 Grok CLI ${installedBefore ? '更新' : '安装'}包`,
            undefined,
            { stage: 'download' },
          )
          let lastReportedBucket = -1
          // 百分比只在有新数据时才动，所以一条不通的线路看上去和「正在下载」
          // 完全一样。心跳把静止的那段时间说出来，用户才知道该等还是该换线路。
          let lastDownloadActivity = Date.now()
          const stallTicker = setInterval(() => {
            const idleMs = Date.now() - lastDownloadActivity
            if (idleMs < grokDownloadStallHeartbeatMs) return
            sendInstallProgress(
              target,
              provider,
              'output',
              grokDownloadStallMessage(idleMs),
              undefined,
              { stage: 'download', elapsedMs: idleMs },
            )
          }, grokDownloadStallHeartbeatMs)
          try {
            downloadedGrokBinary = await downloadLatestGrokBinary({
              fetchImpl: downloadFetch,
              bucket: grokBucketDownloads,
              installedVersion: versionBeforeUpdate,
              withVendorDownloadRoute: (operation) => withDownloadAcceleration(
                (message) => sendInstallProgress(target, provider, 'output', message),
                operation,
              ),
              ...(versionChoice.source === 'latest' ? {} : { version: versionChoice.version }),
              ...(cancellation ? { signal: cancellation.signal } : {}),
              onStableUnavailable: (detail) => runtimeLog?.log('warn', 'install', 'grok-stable.unavailable', '查不到 xAI 的 Grok 稳定版版本号，照指定版本直接下载', { detail }),
              createTemporaryDirectory: () => createInstallTemporaryDirectory('grok-binary'),
              onProgress: ({ percent, transferred, total }) => {
                lastDownloadActivity = Date.now()
                const bucket = Math.floor(percent / 5)
                if (bucket === lastReportedBucket && percent !== 100) return
                lastReportedBucket = bucket
                sendInstallProgress(
                  target,
                  provider,
                  'output',
                  `Grok CLI 下载 ${percent}%（${Math.floor(transferred / 1024 / 1024)} / ${Math.floor(total / 1024 / 1024)} MiB）`,
                  percent,
                  { stage: 'download' },
                )
              },
            })
          } finally {
            clearInterval(stallTicker)
          }
          sendInstallProgress(
            target,
            provider,
            'output',
            `xAI 签名与文件校验通过（${downloadedGrokBinary.version}，SHA-256 ${downloadedGrokBinary.sha256Hex.slice(0, 16)}…）`,
            undefined,
            { stage: 'install' },
          )
          cancellation?.seal(grokBinarySwapSealReason)
          const installed = await installDownloadedGrokBinary(downloadedGrokBinary, sameUserInstall
            ? {
                managedRoot: path.join(os.homedir(), '.grok', 'bin'),
                protectInstallDirectory: false,
              }
            : {})
          cancellation?.unseal()
          invalidateCliUpdateCache(provider)
          sendInstallProgress(target, provider, 'output', `${definition.name} 已写入，正在检查安装结果`, undefined, { stage: 'final-check' })
          const verification = await inspectCliTool(provider, null, null, installed.executablePath)
          if (
            !verification.installation
            || !verification.status.version
            || verification.status.version !== installed.version
            || path.resolve(verification.installation.commandPath) !== path.resolve(installed.executablePath)
          ) {
            throw new Error('Grok CLI 安装后验证失败：未识别到托管可执行文件或版本不一致')
          }
          await recordCliUpdate(provider, versionBeforeUpdate, installed.version, versionChoice.source === 'requested')
          sendInstallProgress(
            target,
            provider,
            'success',
            `${definition.name} ${installedBefore ? '更新' : '安装'}完成（${installed.version}）`,
          )
          return
        }
      }

      // Mac 上客户自己那份 Node.js 太旧时用代下的那份装：npm 用它自带的，跑 npm 的环境也把它
      // 排最前，npm 和工具的安装脚本都靠 `#!/usr/bin/env node` 找 node（第三十四批 A）。
      const nodeDirectories = await preferredNodeDirectories()
      const npmExecutable = await findNpmForCliInstall(provider, target, nodeDirectories)
      let installPrefix: string | null = null
      if (process.platform === 'win32' && windowsExecutionMode === 'trusted-only') {
        managedNpmLayout = await ensureManagedNpmLayout()
      } else if (platform !== 'win32' && provider !== 'grok') {
        // Linux 与 macOS 一样装进当前用户自己的托管目录（Linux 版拆分 ②）：发行版 npm 的
        // 默认全局目录是 /usr，普通权限写不进去；装进 Node.js 自己的目录又会在换 Node 时一起丢掉。
        managedNpmLayout = await ensureManagedNpmLayout({
          platform,
          env: commandEnvironment(),
        })
      }
      // 普通权限安装给 npm 的是空 --userconfig（不让用户 .npmrc 改源、改脚本策略），
      // 这也把用户在 .npmrc 里改过的全局目录一并丢了：新版装进 npm 默认目录，
      // 用户自己敲的命令还是旧版。这里只把 prefix 这一项读回来显式传给 npm。
      // 提权安装走托管目录，绝不读用户可写的配置来决定管理员令牌写到哪里。
      const sameUserNpmPrefix = !managedNpmLayout
        && provider !== 'grok'
        && !(process.platform === 'win32' && windowsExecutionMode === 'trusted-only')
        ? await resolveSameUserNpmPrefix({ env: commandEnvironment(), platform })
        : null
      if (sameUserNpmPrefix) {
        runtimeLog?.log(
          'info',
          'install',
          'cli.install.user-npm-prefix',
          `${definition.name} 按用户 npm 配置安装到 ${redactHomeDirectory(sameUserNpmPrefix.prefix, providerRoots.userHome)}`,
          { provider },
        )
      }
      managedNpmTransaction = await createInstallTemporaryDirectory('npm-transaction', {
        ...(managedNpmLayout ? { baseDirectory: managedNpmLayout.cacheRoot } : {}),
      })
      // 更新和回滚都要替换这个工具已经装好的文件。工具还开着的时候,Windows 会
      // 锁住它自己的可执行文件,替换必然失败;检测只是为了把话说对,所以它既不
      // 拦更新,失败也不影响流程(候选 5 第 2 层)。
      if (provider !== 'grok') {
        if (managedNpmLayout) {
          occupancyProbeRoot = managedCliPackageDirectory(managedNpmLayout.prefix, definition.packageName, platform)
        } else if (sameUserNpmPrefix) {
          occupancyProbeRoot = cliPackageDirectoryFromNpmRoot(
            npmPrefixGlobalRoot(sameUserNpmPrefix.prefix, platform),
            definition.packageName,
          )
        } else {
          const npmGlobalRoot = await resolveServiceNpmGlobalRoot(npmExecutable)
          occupancyProbeRoot = npmGlobalRoot
            ? cliPackageDirectoryFromNpmRoot(npmGlobalRoot, definition.packageName)
            : null
        }
        if (occupancyProbeRoot && fs.existsSync(occupancyProbeRoot)) {
          updatingExistingInstall = true
          versionBeforeUpdate = await readPackageManifestVersion(
            path.join(occupancyProbeRoot, 'package.json'),
            `${definition.name} package.json`,
          )
          const probe = await probeRunningCliProcesses(occupancyProbeRoot)
          runtimeLog?.log(
            probe.status === 'checked' ? 'info' : 'warn',
            'install',
            'cli.running-processes.probe',
            `${definition.name} 更新前进程检测：${probe.status}（${probe.processes.length} 个）`,
            {
              provider,
              status: probe.status,
              processes: probe.processes.length,
              ...(probe.detail ? { detail: redactHomeDirectory(probe.detail, providerRoots.userHome) } : {}),
            },
          )
          const warning = describeRunningCliProcessWarning(definition.name, probe)
          if (warning) sendInstallProgress(target, provider, 'output', warning)
        }
      }
      sendInstallProgress(
        target,
        provider,
        'output',
        versionChoice.source === 'latest'
          ? '正在从 npm 官方源校验最新版本和 SHA-512 完整性元数据'
          : `正在从 npm 官方源校验${versionChoice.source === 'recommended' ? '推荐' : '指定'}版本 ${versionChoice.version} 和 SHA-512 完整性元数据`,
        undefined,
        { stage: 'version' },
      )
      const trustedRelease = await resolveCliInstallRelease(provider, {
        version: versionChoice.version,
        fetchNpmRelease: (registry, packageName, version) => (
          fetchNpmPackageReleaseMetadata(registry, packageName, version, registryMetadataFetch)
        ),
      })
      if (!npmExecutable) throw new Error('未检测到 npm，请先安装 Node.js')
      const networkRegion = await inspectNetworkRegion()
      // Derived from the routing rather than restated, so the line can never
      // claim one registry while npmInstallRegistries picks the other. That had
      // already happened once: the unknown branch still advertised the official
      // registry after the ordering moved to mirror-first.
      const [primaryRegistry] = npmInstallRegistries(networkRegion)
      const primaryLabel = primaryRegistry === npmMirrorRegistry ? '国内 npm 镜像' : 'npm 官方源'
      // 策略钉死时 networkRegion 是归约值而非探测结果，"检测到"的措辞会撒谎。
      const regionLabel = store.read().mirrorPolicy
        ? '已按设置固定安装源顺序'
        : acceleratedDownloadCount() > 0
        ? '已启用下载加速，优先使用官方源'
        : networkRegion === 'mainland-china'
          ? '检测到中国大陆网络'
          : networkRegion === 'outside-mainland-china'
            ? '检测到非中国大陆网络'
            : '未能识别网络区域，按国内网络处理'
      const action = `${regionLabel}，正在通过${primaryLabel}安装已校验版本 ${definition.packageName}@${trustedRelease.version}`
      sendInstallProgress(target, provider, 'started', action, undefined, { stage: 'download' })
      const transaction = managedNpmTransaction
      const npmUserConfig = managedNpmLayout?.userConfig ?? path.join(transaction, 'npmrc')
      if (!managedNpmLayout) {
        const handle = await fs.promises.open(npmUserConfig, 'wx', 0o600)
        await handle.close()
      }
      /**
       * The dependency-graph resolution and the package download are timed
       * separately. Sharing one budget meant a slow official resolution ate the
       * time the download still needed, and a legitimately slow resolution was
       * being killed at five minutes as if it had hung.
       */
      // 解析一次就够：加速开关在一次安装中途变化时，换代理反而会让已经建立
      // 的连接和重试落到两条不同的线路上。
      let npmProxyVariables: NodeJS.ProcessEnv | null = null
      const resolveNpmProxyVariables = async (): Promise<NodeJS.ProcessEnv> => {
        if (!npmProxyVariables) {
          try { npmProxyVariables = await resolveSubprocessProxyEnvironment() }
          catch { npmProxyVariables = {} }
        }
        return npmProxyVariables
      }
      // npm 认 https_proxy / http_proxy：电脑里留着指向没开的本机代理时，没开加速就一样
      // 装不上。同一次安装只判断一次，日志也只写一条。Linux 上照着网上教程把
      // `export http_proxy=…7890` 写进 ~/.profile 的很常见，同样要绕开（Linux 版拆分 ②）；
      // macOS 维持原样。
      let npmBaseEnvironment: Promise<NodeJS.ProcessEnv> | null = null
      const resolveNpmBaseEnvironment = (trustedOnly: boolean): Promise<NodeJS.ProcessEnv> => {
        if (!npmBaseEnvironment) {
          // 公司或安全软件装在这台电脑上的证书，npm 默认不认（system-certificate-trust.ts）。
          // 管理员身份那条路不加：trustedCommandEnvironment 会把它剥掉，这里也不补回去。
          const base = trustedOnly ? trustedCommandEnvironment() : withSystemCertificateTrust(commandEnvironment(process.env, nodeDirectories))
          npmBaseEnvironment = platform !== 'darwin' ? withoutDeadLoopbackProxies(base, provider) : Promise.resolve(base)
        }
        return npmBaseEnvironment
      }
      const executeNpm = async (
        argv: string[],
        cwd: string,
        cache: string,
        timeoutMs = npmDownloadTimeoutMs,
        signal?: AbortSignal,
      ) => {
        // 提权执行会对 argv 里的每个绝对路径做 realpath，路径不存在即判定为
        // 「位于用户可写目录」而拒绝。npm 自己会建缓存目录，但那发生在校验之后。
        await fs.promises.mkdir(cache, { recursive: true })
        const trustedOnly = process.platform === 'win32' && windowsExecutionMode === 'trusted-only'
        // 调用处自己的信号（下载卡住）和客户的取消，哪个先到都结束这次 npm；
        // 是哪一个由调用处分辨，取消照旧报「安装已取消」。
        const abortSignal = cancellation && signal
          ? AbortSignal.any([cancellation.signal, signal])
          : cancellation?.signal ?? signal
        return executeCommand({
          executable: npmExecutable,
          argv: [
            ...argv,
            `--cache=${cache}`,
            `--userconfig=${npmUserConfig}`,
            '--audit=false',
            '--fund=false',
          ],
          windowsPackageManager: 'npm',
        }, {
          env: {
            ...await resolveNpmBaseEnvironment(trustedOnly),
            ...await resolveNpmProxyVariables(),
          },
          trustedOnly,
          trustedPaths: managedNpmLayout
            ? [npmUserConfig, transaction]
            : undefined,
          ...(abortSignal ? { signal: abortSignal } : {}),
          cwd,
          timeoutMs,
          maxOutputBytes: 8 * 1024 * 1024,
          onOutput: ({ text }) => {
            const message = text.trim()
            if (message) sendInstallProgress(target, provider, 'output', message, undefined, { stage: 'raw-output' })
          },
        })
      }
      const assertCliNativePackageInstalled = async (packageRoot: string) => {
        const missing = await findMissingCliNativePackage(packageRoot, definition.packageName, platform)
        if (!missing) return
        runtimeLog?.log(
          'warn',
          'install',
          'cli.install.native-package-missing',
          `${definition.name} 的平台主程序包 ${missing} 没有装上（npm 跳过了下载失败的可选依赖）`,
          { provider },
        )
        throw new Error(cliNativePackageMissingMessage(definition.name))
      }
      const createResolutionManifest = async (directory: string) => {
        await fs.promises.mkdir(directory, { recursive: true })
        const manifestPath = path.join(directory, 'package.json')
        const handle = await fs.promises.open(manifestPath, 'wx', 0o600)
        try {
          await handle.writeFile(`${JSON.stringify(
            buildCliResolutionManifest(provider, trustedRelease.version),
            null,
            2,
          )}\n`, 'utf8')
          await handle.sync()
        } finally {
          await handle.close()
        }
      }
      /**
       * npm emits nothing during `--package-lock-only`, so without a heartbeat
       * the window sits on one static line for minutes and users conclude the
       * app has hung. The ticker only reports elapsed time; it never guesses at
       * a completion percentage it cannot know.
       */
      const resolveDependencyGraph = async (
        registry: string,
        resolution: string,
        cache: string,
      ) => {
        sendInstallProgress(target, provider, 'output', npmResolutionStartMessage(registry), undefined, { stage: 'download' })
        const startedAt = Date.now()
        const ticker = setInterval(() => {
          const elapsedMs = Date.now() - startedAt
          sendInstallProgress(
            target,
            provider,
            'output',
            npmResolutionHeartbeatMessage(registry, elapsedMs),
            undefined,
            { stage: 'download', elapsedMs },
          )
        }, npmResolutionHeartbeatMs)
        // 国内没开加速时，连官方源这一步常常一个字节也收不到，以前要干等满 10 分钟（#1057 第5b条）。
        // 这一步拉的包信息同样边收边写进缓存的临时文件，所以照下载那一步看目录：3 分钟一点没变就停，
        // 慢但一直在收的照旧等到 10 分钟。缓存目录要等 executeNpm 建，没建好之前量不到，量不到不算卡住。
        const stallWatch = createNpmDownloadStallWatch(async () => (
          await measureDirectoryBytes(resolution) + await measureDirectoryBytes(cache)
        ))
        const watchStartedAt = performance.now()
        try {
          await executeNpm([
            'install',
            '--package-lock-only',
            '--ignore-scripts',
            '--omit=dev',
            `--registry=${registry}`,
          ], resolution, cache, npmResolutionTimeoutMs, stallWatch.signal)
        } catch (error) {
          if (!stallWatch.stalled) throw error
          runtimeLog?.log(
            'warn',
            'install',
            'cli.install.resolution-stalled',
            `${definition.name} 在${npmRegistryLabel(registry)}解析依赖图 ${formatElapsedDuration(npmDownloadStallTimeoutMs)}没有进展，已中止`,
            {
              provider,
              registry,
              elapsedMs: Math.round(performance.now() - watchStartedAt),
              attemptBytes: stallWatch.bytes,
            },
          )
          // 和满 10 分钟超时是同一句（describeNpmCommandFailure 对 TIMED_OUT 给的也是它），后面的报错照旧。
          throw new Error(npmDownloadTimedOutMessage, { cause: error })
        } finally {
          clearInterval(ticker)
          stallWatch.stop()
        }
      }

      const officialResolution = path.join(transaction, 'official-resolution')
      const officialCache = path.join(transaction, 'official-cache')
      await createResolutionManifest(officialResolution)
      try {
        await resolveDependencyGraph(npmOfficialRegistry, officialResolution, officialCache)
      } catch (error) {
        if (isInstallCancelledError(error)) throw error
        cancellation?.throwIfCancelled()
        const raw = describeNpmCommandFailure(error)
        const reason = npmSourceFailure(redactCommandText(raw), { commandFailed: isNpmExitFailure(error) })
        // 这一步只走官方源，换镜像绕不过去；连不上时说清这一点和下一步（#1057 第5b条）。加速已经开着、
        // 或者这个平台没有加速（Linux）时，叫人开加速没用，改说换个网络。
        if (reason.kind === 'network') {
          const nextStep = platformCapabilitiesFor(platform).acceleration && acceleratedDownloadCount() === 0
            ? '到「设置 › 网络加速」开启加速后再试。'
            : '换个网络（比如手机热点）后再试。'
          throw new Error(`${definition.name} 安装失败：装之前要先到 npm 官方源核对安装清单，${officialRegistryUnreachableMarker}${npmErrorCodesClause([reason])}。${nextStep}`, { cause: error })
        }
        const message = npmFailureSentence(`${definition.name} 安装失败：`, [{ label: 'npm 官方源', reason }])
        throw new Error(await withToolCertificateHint(message, raw), { cause: error })
      }
      const officialLock = await readBoundedUtf8File(
        path.join(officialResolution, 'package-lock.json'),
        maximumNpmPackageLockBytes,
        'npm 官方 package-lock.json',
      )
      assertNpmReleaseMatchesOfficialLock(trustedRelease, officialLock)
      const registries = npmInstallRegistries(networkRegion)
      const installErrors: string[] = []
      const installFailures: NpmFailurePart[] = []
      let installed = false
      let verification: Awaited<ReturnType<typeof inspectCliTool>> | null = null
      for (const [index, registry] of registries.entries()) {
        cancellation?.throwIfCancelled()
        if (index > 0) {
          sendInstallProgress(
            target,
            provider,
            'output',
            `${registries[0] === npmMirrorRegistry ? '国内 npm 镜像' : 'npm 官方源'}安装失败，正在切换${registry === npmMirrorRegistry ? '国内 npm 镜像' : 'npm 官方源'} ${registry}`,
            undefined,
            { stage: 'switch-route' },
          )
        }
        const attemptRoot = path.join(transaction, `attempt-${index}`)
        // 正在往正在用的工具目录里写；这一步失败时它还是 true（见 isMachineBoundNpmFailure）。
        let writingFolderInUse = false
        // 正在把正在用的工具目录复制进暂存目录；这一步失败时它还是 true。
        let copyingFolderInUse = false
        try {
          const resolution = path.join(attemptRoot, 'resolution')
          const cache = path.join(attemptRoot, 'cache')
          const attemptPrefix = managedNpmLayout
            ? path.join(attemptRoot, 'staged-prefix')
            : null
          await createResolutionManifest(resolution)
          await resolveDependencyGraph(registry, resolution, cache)
          const candidateLock = await readBoundedUtf8File(
            path.join(resolution, 'package-lock.json'),
            maximumNpmPackageLockBytes,
            `${registry === npmMirrorRegistry ? '国内镜像' : 'npm 官方'} package-lock.json`,
          )
          assertNpmPackageLocksEquivalent(
            officialLock,
            candidateLock,
            definition.packageName,
            trustedRelease.version,
          )
          sendInstallProgress(
            target,
            provider,
            'output',
            `${registry === npmMirrorRegistry ? '国内 npm 镜像' : 'npm 官方源'}完整依赖图与官方 SHA-512 对账通过，正在下载校验包缓存`,
            undefined,
            { stage: 'verify' },
          )
          // 下载这一步看的是还在不在下，不是总共下了多久：网慢的客户以前满 5 分钟就被掐、换源
          // 从零再下，怎么点都装不上。这一轮的临时目录 3 分钟一点没变才算卡住、换下一个源，
          // 慢但一直在下的最多等 30 分钟（第三十七批 A）。
          const stallWatch = createNpmDownloadStallWatch(() => measureDirectoryBytes(attemptRoot))
          const downloadStartedAt = performance.now()
          // 同解析那一步：带上已用时，界面进度那一行就换成现成的「还在下载，已经等了……」，
          // 这句原话进安装日志；运行日志不记这种每隔几秒一条的（第三十七批 D）。
          const downloadTicker = setInterval(() => {
            const elapsedMs = Math.round(performance.now() - downloadStartedAt)
            sendInstallProgress(
              target,
              provider,
              'output',
              npmDownloadHeartbeatMessage(registry, elapsedMs),
              undefined,
              { stage: 'download', elapsedMs },
            )
          }, npmDownloadHeartbeatMs)
          try {
            await executeNpm([
              'ci',
              '--ignore-scripts',
              '--omit=dev',
              `--registry=${registry}`,
              '--replace-registry-host=always',
            ], resolution, cache, npmDownloadCeilingMs, stallWatch.signal)
          } catch (error) {
            if (!stallWatch.stalled) throw error
            runtimeLog?.log(
              'warn',
              'install',
              'cli.install.download-stalled',
              `${definition.name} 从${npmRegistryLabel(registry)}下载 ${formatElapsedDuration(npmDownloadStallTimeoutMs)}没有进展，已中止`,
              {
                provider,
                registry,
                elapsedMs: Math.round(performance.now() - downloadStartedAt),
                attemptBytes: stallWatch.bytes,
              },
            )
            throw new Error(npmDownloadTimedOutMessage, { cause: error })
          } finally {
            clearInterval(downloadTicker)
            stallWatch.stop()
          }
          // npm ci 跳过下载失败的平台主程序包也照样退出 0，所以下完就在它解出来的包里查。普通权限
          // 那条路没有暂存目录，后面 npm 直接写进正在用的工具目录，写完再查就晚了，旧版已经被盖掉；
          // 在这里查出缺了，记成这个源失败、换下一个源，旧版还没动（第二十八批 A）。Grok 的两条
          // npm 通道在自己的安装事务里核对。
          if (provider !== 'grok') {
            await assertCliNativePackageInstalled(
              path.join(resolution, 'node_modules', ...definition.packageName.split('/')),
            )
          }
          if (managedNpmLayout && attemptPrefix) {
            copyingFolderInUse = true
            await fs.promises.cp(managedNpmLayout.prefix, attemptPrefix, {
              recursive: true,
              force: false,
              errorOnExist: true,
            })
            copyingFolderInUse = false
          }
          const plan = buildCliMaintenancePlan(
            provider,
            npmExecutable,
            attemptPrefix ?? sameUserNpmPrefix?.prefix ?? null,
            trustedRelease.version,
            true,
            platform,
          )
          sendInstallProgress(target, provider, 'output', `${definition.name} 下载校验完成，正在安装到本机`, undefined, { stage: 'install' })
          const lifecycle = () => executeNpm([
            ...plan.argv,
            '--offline',
            `--registry=${registry}`,
          ], resolution, cache).then(() => undefined)
          if (provider === 'grok' && grokInstallStrategy === 'darwin-official-npm') {
            verification = await runDarwinGrokPostInstallTransaction({
              homeDirectory: os.homedir(),
              lifecycle,
              verify: async () => {
                const inspected = await inspectVerifiedDarwinGrokPostInstall({
                  homeDirectory: os.homedir(),
                  expectedVersion: trustedRelease.version,
                  runCommand: buildDarwinTrustedVerificationRunner(executeCommand),
                })
                if (!inspected.installation || inspected.status.version !== trustedRelease.version) {
                  throw new Error(`${definition.name} 安装后服务验证失败，已恢复更新前版本`)
                }
                return inspected
              },
            })
          } else if (provider === 'grok' && grokInstallStrategy === 'linux-official-npm') {
            // 核对用的主程序包就在这次 npm ci 的 resolution 目录里，事务结束前它都还在。
            verification = await runLinuxGrokPostInstallTransaction({
              homeDirectory: os.homedir(),
              lifecycle,
              verify: () => inspectVerifiedLinuxGrokPostInstall({
                homeDirectory: os.homedir(),
                expectedVersion: trustedRelease.version,
                resolutionDirectory: resolution,
                architecture: process.arch,
                runCommand: buildDarwinTrustedVerificationRunner(executeCommand),
              }),
            })
          } else {
            // 普通权限这条路没有暂存目录：npm 在正在用的目录里先挪开旧版、再解新包、跑安装脚本，取消是
            // 强行结束整棵进程树，它来不及挪回去，新旧两份都用不了。所以从这里起和暂存那条路换进去
            // 以后一样不让取消，前面下载、对账照样能取消（第二十八批 B）。
            const writesInPlace = !attemptPrefix
            if (writesInPlace) {
              cancellation?.throwIfCancelled()
              cancellation?.seal(managedPrefixSwapSealReason)
            }
            try {
              writingFolderInUse = writesInPlace
              await lifecycle()
              writingFolderInUse = false
              // 在这一个源里就查：缺了就记成这个源失败，接着换下一个源再下一次，
              // 而不是带着装不全的程序走到替换托管目录那一步。
              const stagedPrefix = attemptPrefix ?? sameUserNpmPrefix?.prefix ?? null
              if (stagedPrefix) {
                await assertCliNativePackageInstalled(
                  managedCliPackageDirectory(stagedPrefix, definition.packageName, platform),
                )
              }
            } catch (error) {
              // 这个源没装成，换下一个源要重新下载，下载那段照样能取消。装成了就一直不让取消到结束：
              // 新版已经写进去了，这时再取消，界面会以为没装上。
              if (writesInPlace) cancellation?.unseal()
              throw error
            }
          }
          installPrefix = attemptPrefix
          installed = true
          break
        } catch (error) {
          if (isInstallCancelledError(error)) throw error
          cancellation?.throwIfCancelled()
          const detail = describeNpmCommandFailure(error)
          const label = registry === npmMirrorRegistry ? '国内 npm 镜像' : 'npm 官方源'
          const redacted = redactCommandText(detail).replace(/\s+/g, ' ').trim().slice(0, 300) || '安装失败'
          installErrors.push(`${label}：${redacted}`)
          installFailures.push({ label, reason: npmSourceFailure(redacted, { commandFailed: isNpmExitFailure(error) }) })
          // 这个源下了一半的东西先删掉再换源：下载最长能等 30 分钟，留到整次安装结束才删，
          // 盘快满时下一个源更容易写不下。删不掉就算了，结束时 finally 还会整个再删一次。
          await fs.promises.rm(attemptRoot, { recursive: true, force: true }).catch(() => undefined)
          // 复制正在用的工具目录这一步跟从哪个源下的无关，换个源下完还是复制同一份、撞上同一个错（多半是
          // 没有权限读，#1157 第 14 条），所以这一步怎么失败的都不换源。
          if (copyingFolderInUse || isMachineBoundNpmFailure(detail, writingFolderInUse)) {
            runtimeLog?.log(
              'warn',
              'install',
              'cli.install.machine-bound-failure',
              `${definition.name} 写不进本机（盘满、文件被占用或没有权限），换 npm 源也一样，不再换源`,
              { provider, registry, writingFolderInUse, copyingFolderInUse },
            )
            break
          }
        }
      }
      if (!installed) {
        const detail = installErrors.join('；') || '所有 npm 源均不可用'
        // npm 替换正在运行的工具时报的是 EBUSY / EPERM,两者的原文都读不出「谁
        // 占着这个文件」。这里重新数一遍进程,数到了才改写成「文件被占用」。
        const occupied = await describeOccupiedCliFailure(provider, detail, detail, occupancyProbeRoot, updatingExistingInstall ? '更新' : '安装')
        // 每个源只说中文原因，错误码留在句尾给界面认；npm 的英文原话进运行日志（#1100 第1条）。
        const message = installFailures.length
          ? npmFailureSentence(`${definition.name} 安装失败：`, installFailures)
          : `${definition.name} 安装失败：${detail}`
        throw new Error(occupied ?? await withToolCertificateHint(message, detail), { cause: new Error(detail) })
      }
      sendInstallProgress(target, provider, 'output', `${definition.name} 已安装，正在检查安装结果`, undefined, { stage: 'final-check' })
      invalidateCliUpdateCache(provider)
      const stagedManifest = installPrefix
        ? path.join(
            installPrefix,
            ...(platform !== 'win32' ? ['lib', 'node_modules'] : ['node_modules']),
            ...definition.packageName.split('/'),
            'package.json',
          )
        : null
      if (stagedManifest) {
        const stagedVersion = await readPackageManifestVersion(
          stagedManifest,
          `${definition.name} staged package.json`,
        )
        if (stagedVersion !== trustedRelease.version) {
          throw new Error(`${definition.name} 暂存安装验证失败：版本或 package.json 无效`)
        }
      }

      // 两条 npm 官方通道都在 postinstall 事务里核对过了（macOS 靠 codesign，Linux 靠逐字节对账）。
      const grokPostInstallVerified = provider === 'grok'
        && (grokInstallStrategy === 'darwin-official-npm' || grokInstallStrategy === 'linux-official-npm')
      if (managedNpmLayout && managedNpmTransaction && installPrefix) {
        cancellation?.seal(managedPrefixSwapSealReason)
        let promotion: ManagedNpmReplaceResult | null = null
        try {
          promotion = await replaceManagedNpmPrefixAtomically(
            managedNpmLayout.prefix,
            installPrefix,
            managedNpmTransaction,
            async () => {
              invalidateCliUpdateCache(provider)
              const promoted = await inspectCliTool(
                provider,
                npmExecutable,
                path.join(
                  managedNpmLayout!.prefix,
                  ...(platform !== 'win32' ? ['lib', 'node_modules'] : ['node_modules']),
                ),
              )
              if (
                !promoted.installation
                || promoted.status.version !== trustedRelease.version
                || !isManagedNpmInstallation(promoted.installation)
              ) {
                throw new Error(`${definition.name} 提交后验证失败，已恢复更新前版本`)
              }
              verification = promoted
            },
          )
        } catch (error) {
          // 回滚也没成的那一种不碰：ManagedNpmRollbackError 要原样传到外层（它的
          // preserveTransaction 决定事务目录留不留），它的原话也是渲染层不套
          // 安抚文案的依据。
          if (error instanceof ManagedNpmRollbackError) throw error
          const detail = error instanceof Error ? error.message : String(error)
          const occupied = await describeOccupiedCliFailure(
            provider,
            error,
            redactCommandText(detail).replace(/\s+/g, ' ').trim().slice(0, 300),
            occupancyProbeRoot,
            updatingExistingInstall ? '更新' : '安装',
          )
          if (!occupied) throw error
          throw new Error(occupied, { cause: error })
        }
        if (!promotion.backupRetired) {
          runtimeLog?.log(
            'warn',
            'install',
            'cli.install.backup-retire-failed',
            `${definition.name} 新版已检查通过，但旧版那份没能标成已换下；临时文件夹删完之前退出的话，下次装工具时会被退回旧版`,
            { provider },
          )
        }
      } else if (!grokPostInstallVerified) {
        const npmGlobalRoot = await resolveServiceNpmGlobalRoot(npmExecutable)
        verification = await inspectCliTool(provider, npmExecutable, npmGlobalRoot)
        if (verification.installation?.source === 'npm' && verification.installation.packageRoot) {
          await assertCliNativePackageInstalled(verification.installation.packageRoot)
        }
      }
      if (!grokPostInstallVerified && (
        !verification?.installation
        || verification.status.version !== trustedRelease.version
        || (managedNpmLayout && !isManagedNpmInstallation(verification.installation))
      )) {
        throw new Error(`${definition.name} npm 命令已结束，但未在托管目录识别到有效安装和版本`)
      }
      // npm 每次安装都会把 .ps1 启动文件重新写回来，所以装完、更新完都要再清一遍。
      if (verification?.installation) await cliTerminalAccess.prepare({ provider, installation: verification.installation }, 'install')
      await recordCliUpdate(provider, versionBeforeUpdate, verification?.status.version ?? null, versionChoice.source === 'requested')
      sendInstallProgress(
        target,
        provider,
        'success',
        `${definition.name} 安装或更新完成（${verification!.status.version}）`,
      )
    } catch (error) {
      if (error instanceof ManagedNpmRollbackError) {
        preserveManagedNpmTransaction = error.preserveTransaction
      }
      // 取消是用户自己按的,不是安装失败:换成统一的中文文案,并且把底层
      // 「命令被中止」这类实现细节挡在外面,否则界面会像出了故障。
      if (isInstallCancelledError(error) || cancellation?.cancelled === true) {
        const cancelled = new InstallCancelledError(`${definition.name} 安装已取消`)
        sendInstallProgress(target, provider, 'error', cancelled.message)
        throw cancelled
      }
      const message = error instanceof Error ? error.message : String(error)
      sendInstallProgress(target, provider, 'error', message)
      throw error
    } finally {
      if (downloadedGrokBinary) await cleanupDownloadedGrokBinary(downloadedGrokBinary)
      if (managedNpmTransaction && !preserveManagedNpmTransaction) {
        // 几百 MB 的目录删起来要一会儿，安全软件、索引服务常在中途攥住刚解出来的文件：让 rm 自己
        // 等一等再删（同 install-leftovers.ts）。还删不掉的过 6 小时由那边清；新版检查通过的话，
        // 里面的旧版这时已经改名成 superseded-prefix，下次装工具时不会再被退回去。
        await fs.promises.rm(managedNpmTransaction, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 })
          .catch((error: unknown) => {
            runtimeLog?.log(
              'warn',
              'install',
              'cli.install.transaction-cleanup-failed',
              `${definition.name} 安装用的临时文件夹没删掉，之后会自动清理`,
              {
                provider,
                error: redactHomeDirectory(error instanceof Error ? error.message : String(error), providerRoots.userHome),
              },
            )
          })
      }
      installing.delete(provider)
    }
  }

  function installCli(provider: ProviderId, target: RendererMessageTarget, version?: string): Promise<void> {
    // 队列 key 刻意不含版本:同一个工具的两次安装必须串行(I11),
    // 让「更新」和「回到推荐版本」同时跑会互相看到半完成的全局目录。
    const key = `cli:install:${provider}`
    // 重复点击复用队列里的同一个 Promise,所以这里也不能再开一个取消句柄:
    // 后点的那次会把前一次的句柄挤掉,取消按钮就再也找不到正在跑的安装。
    // Windows 上 Claude Code 接着装 Git 的那一段句柄也还登记着(见 finishClaudeInstallWithGit),
    // 这时再装一次 Claude Code 会走到这里,另排一次取消不了的安装;界面上同一个工具
    // 一次只放一个安装(useToolbox 的 run 按工具加锁),碰不到。
    if (installCancellations.has(key)) {
      // 复用只对同一个版本成立：「回到某个版本」并进正在跑的「更新」，会跟着报成功，
      // 装上的却是新版（#1061 第 9 条）。版本不同就直接拒，等这一次装完再点。
      // 不发进度：进度按工具发，发一条失败会写到正在跑的那次的进度行上。
      if (installRequestedVersions.get(provider) !== version) {
        return Promise.reject(new Error(`${cliCatalog[provider].name} 正在安装中`))
      }
      return installationQueue.enqueue(key, () => installCliOperation(provider, target, version))
    }
    // 句柄在入队之前登记:排在别人后面等待的那次安装也要能取消,
    // 否则用户只能干等前一个工具装完。
    const cancellation = installCancellations.begin(key)
    installRequestedVersions.set(provider, version)
    let started = false
    const finished = installationQueue.enqueue(
      key,
      () => {
        started = true
        return installCliOperation(provider, target, version, cancellation)
      },
      { signal: cancellation.signal },
    ).catch((error: unknown) => {
      if (started) throw error
      // 排着队时取消的那次直接出队，installCliOperation 没跑过：取消的那句和进度在这里补上，
      // 和跑起来以后取消一样。
      const cancelled = new InstallCancelledError(`${cliCatalog[provider].name} 安装已取消`)
      sendInstallProgress(target, provider, 'error', cancelled.message)
      throw cancelled
    })
    // 装好一次顺手清掉以前中途被打断的残留：这次自己的临时目录已经在 finally 里删了，
    // 剩下的只会是更早的。排在队列末尾，不拖慢这次安装的完成提示。
    void finished.then(() => cleanupInstallLeftovers(), () => undefined)
    // Windows 上 Claude Code 靠 Git 自带的 bash 跑技能和插件里的命令。Claude Code 自己
    // 那一项出队之后才排 Git：队列是全局串行的，在队列任务里再入队会互相等死。
    if (provider !== 'claude' || platform !== 'win32') return finished.finally(() => cancellation.release())
    return finishClaudeInstallWithGit(finished, cancellation, () => installGitAlongsideClaude(
      () => installGitRuntime(target, (progress) => sendInstallProgress(
        target, provider, 'output', progress.message, progress.percent ?? undefined)),
      (message) => sendInstallProgress(target, provider, 'output', message),
    ))
  }

  function resolveInstallLeftoverLocations(): InstallLeftoverLocation[] {
    let trustedCacheRoot: string | null = null
    try {
      trustedCacheRoot = trustedInstallerCacheRoot(process.env, platform)
    } catch {
      // ProgramData 解析不出来时安装本身也用不了那里，没有残留可清。
    }
    let managedNpmCache: string | null = null
    try {
      // 和装工具时准备托管目录（ensureManagedNpmLayout）用同一份环境，指的才是同一处。
      managedNpmCache = managedNpmCacheRoot(commandEnvironment(), platform)
    } catch {
      // 同上：解析不出来时托管安装也用不了，那里不会有更新留下的临时文件夹。
    }
    // 安装缓存和托管 npm 缓存都在 ProgramData\XingMangAI 底下。按管理员身份在那里删东西，要这次运行
    // 亲手加固、核过 ACL 的目录才算只有管理员能写（装、卸工具准备托管目录，或建安装用的临时目录时，
    // 会把整个 XingMangAI 加固一遍）。没核过的那一处可能是普通进程抢先建好、等着在删的时候换成联接的
    // （同 I8），这一轮先不扫，核过以后的那一轮再清：开机后那一轮一般还没核过，装完工具那一轮会清。
    if (platform === 'win32' && trustedCacheRoot && !isRegisteredTrustedManagedWindowsPath(trustedCacheRoot)) {
      trustedCacheRoot = null
    }
    if (platform === 'win32' && managedNpmCache && !isRegisteredTrustedManagedWindowsPath(managedNpmCache)) {
      managedNpmCache = null
    }
    return buildInstallLeftoverLocations({
      platform,
      windowsExecutionMode,
      temporaryDirectory: os.tmpdir(),
      trustedCacheRoot,
      managedNpmCacheRoot: managedNpmCache,
    })
  }

  function cleanupInstallLeftovers(): Promise<InstallLeftoverSweepResult> {
    const sweep = serviceOptions.sweepInstallLeftovers
    const empty: InstallLeftoverSweepResult = { removed: 0, freedBytes: 0, failed: 0 }
    if (!sweep) return Promise.resolve(empty)
    // 走安装队列（I11）：清理和安装、卸载互相等，谁也看不到对方做了一半的目录。
    return installationQueue.enqueue('maintenance:install-leftovers', async () => {
      const result = await sweep(resolveInstallLeftoverLocations())
      if (result.removed || result.failed) {
        runtimeLog?.log('info', 'install', 'install-leftovers.swept', `清掉以前没装完留下的下载 ${result.removed} 份，约 ${Math.round(result.freedBytes / 1024 / 1024)} MB`, {
          removed: result.removed,
          freedBytes: result.freedBytes,
          failed: result.failed,
        })
      }
      return result
    }).catch((error: unknown) => {
      runtimeLog?.log('warn', 'install', 'install-leftovers.failed', '清理以前没装完留下的下载时出错，下次再试', {
        error: error instanceof Error ? error.message : String(error),
      })
      return empty
    })
  }

  function cancelCliInstall(provider: ProviderId): InstallCancellationOutcome {
    return installCancellations.cancel(`cli:install:${provider}`)
  }

  return { installCli, cancelCliInstall, cleanupInstallLeftovers }
}

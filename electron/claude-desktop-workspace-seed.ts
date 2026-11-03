/**
 * Claude Desktop 的 Cowork 工作区（一台小 Linux 虚拟机，压缩后约 1.3 GB）改从星芒自己的存储桶下，替它放好
 * （yoyo 2026-11-03「如果能用这个方式就不要加速了」；方案 /mnt/project-files/加速下线/Claude工作区和Mac-存储桶方案-1103.md）。
 *
 * Claude 自己从 downloads.claude.ai 下，国内下不动，网络加速 10-30 下线以后 Cowork 就一直卡在「下载工作区」。
 * 拆 4.4212.0 看到（claude-desktop-component-manifest.ts 读清单）：
 * - 放在 `<userData>/vm_bundles/claudevm.bundle/`。`<name>` 在、`.<name>.origin` 的内容正好是工作区版本号，
 *   它就当这个文件好了。
 * - 它自己的离线版和「提前下好」用的是同一个缓存格式：`<name>.zst`（官网原样的压缩包）加 `.<name>.zst.origin`
 *   （版本号）。它要用时先看缓存，在就自己解开、按清单核 sha256，核不上把缓存删了重下。
 * - 它下之前会先写一个 `.cowork-adopted`（只在这台电脑跑得了虚拟机时）。
 *
 * 所以这里只放官网原样的 `<name>.zst` 和 `.<name>.zst.origin`，不自己解、不碰它解开的那份，最后核对交给它。
 * 星芒这边：版本和每个文件的 sha256、大小都取自客户电脑上**已经装好的那份 Claude** 自己的程序，桶里的东西
 * 对不上就扔掉，所以桶出了问题最多白下一次，放不进 Claude 的文件夹。
 *
 * 费流量（每台约 1.3 GB，按腾讯云 0.5 元/GB 计），所以只给「真要用」的电脑下：`.cowork-adopted` 在（这台跑得了
 * 虚拟机、它也已经开始要了）、工作区又没好的时候才下；同一版每台电脑一周最多下一次（它不认我们放的，就不再白下）；
 * 远程开关 claude-desktop-workspace-seed 随时能关。从星芒点「打开」以后在后台下，不挡着打开，Claude 开着也照放
 * （只写缓存那两个名字，它解开的那份一点不碰）。
 */
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  readClaudeDesktopComponentManifest,
  type ClaudeCodeComponentPins,
  type ClaudeDesktopComponentManifest,
  type ClaudeDesktopVmArchitecture,
  type ClaudeDesktopVmFile,
  type ClaudeDesktopVmPlatformKey,
} from './claude-desktop-component-manifest'
import { desktopPackageBucketOrigin, fetchDesktopBucketResource } from './desktop-package-bucket'
import { readDiskSpace, installMinimumFreeBytes, type DiskSpaceReading } from './disk-space'
import { downloadWithResume, DownloadStalledError } from './download-retry'
import {
  assertNoReparseComponents, assertSafeDataFile, ensureSafeDataDirectory, readSafeUtf8FileSync, removeSafeDataFile,
  renameWithTransientRetry, writeAtomicSafeUtf8File,
} from './safe-local-data'
import { redactHomeDirectory } from './startup-log'
import type { WindowsCliExecutionMode } from './windows-elevation'

/** 桶里放 Claude 桌面端组件的那一层（docs/cos-sync-policy.json 早就授权的 xingmang/ 底下）。 */
export const claudeDesktopComponentsBucketPrefix = 'xingmang/offline/claude-components'

export type ClaudeDesktopWorkspaceSkipReason =
  | 'unsupported-platform'
  | 'not-same-user'
  | 'remote-off'
  | 'asar-unreadable'
  | 'manifest-not-found'
  | 'architecture-missing'
  | 'target-unresolved'
  | 'not-adopted'
  | 'recently-delivered'
  | 'recently-failed'
  | 'disk-space'
  | 'download-failed'
  | 'write-failed'
  | 'timeout'

export type ClaudeDesktopWorkspaceSeedOutcome =
  | { status: 'ready'; sha: string }
  | { status: 'placed'; sha: string; files: number; bytes: number }
  | { status: 'skipped'; reason: ClaudeDesktopWorkspaceSkipReason }

/** 这一份 Claude 的数据目录、程序文件和它的虚拟机是什么架构（Windows 看安装位置，Mac 看芯片）。 */
export interface ClaudeDesktopComponentTarget {
  profileDirectory: string
  asarPath: string
  architecture: ClaudeDesktopVmArchitecture
}

export interface ClaudeDesktopWorkspaceProgress {
  sha: string
  transferred: number
  total: number
}

export interface ClaudeDesktopWorkspacePaths {
  bundleDirectory: string
  adoptedMarkerPath: string
}

export interface ClaudeDesktopWorkspaceFilePaths {
  raw: string
  rawOrigin: string
  cache: string
  cacheOrigin: string
}

/** Cowork 虚拟机里那份 Linux 版 Claude Code 由别处放（claude-desktop-vm-code-seed.ts），在下工作区之前跑。 */
export interface ClaudeDesktopLinuxCodeSeeder {
  seed(input: { profileDirectory: string; architecture: ClaudeDesktopVmArchitecture; pins: ClaudeCodeComponentPins | null }): Promise<unknown>
}

export interface ClaudeDesktopWorkspaceSeederOptions {
  platform: NodeJS.Platform
  executionMode: WindowsCliExecutionMode
  /** 下载用的 fetch（system-service 传接好系统代理的那个）。 */
  fetch: typeof fetch
  /** 认出这份 Claude 的数据目录、程序文件和架构；认不出给 null。 */
  resolveTarget(clientPath: string): Promise<ClaudeDesktopComponentTarget | null>
  /** 「这一版这台电脑已经下过」记在这里（星芒自己的数据目录下）。 */
  stateDirectory: string
  userHome: string
  isOff?(): boolean
  readManifest?(asarPath: string): Promise<ClaudeDesktopComponentManifest>
  readDiskSpace?(target: string): Promise<DiskSpaceReading | null>
  linuxCode?: ClaudeDesktopLinuxCodeSeeder
  pathModule?: path.PlatformPath
  timeoutMs?: number
  /** 从星芒打开以后隔多久再看一次（Claude 开起来、客户点进 Cowork 它才写 `.cowork-adopted`）。 */
  recheckDelaysMs?: readonly number[]
  onProgress?(event: ClaudeDesktopWorkspaceProgress): void
  onPlaced?(event: { sha: string; files: number; bytes: number }): void
  log?(level: 'info' | 'warn', event: string, message: string, detail?: Record<string, unknown>): void
  now?(): number
  resumeDelaysMs?: readonly number[]
  setTimer?(callback: () => void, milliseconds: number): { cancel(): void }
}

export interface ClaudeDesktopWorkspaceSeeder {
  /** 永不抛错。 */
  seed(clientPath: string): Promise<ClaudeDesktopWorkspaceSeedOutcome>
  /** 从星芒打开 Claude 以后调：马上看一次，之后隔几分钟再看几次。 */
  scheduleAfterLaunch(clientPath: string): void
  dispose(): void
}

/** 一次最多为这件事等多久：1.3 GB 按每秒 150 KB 约两个半小时。再慢就停，下次打开再来（从头下）。 */
export const claudeDesktopWorkspaceSeedTimeoutMs = 3 * 60 * 60_000
/** 同一版同一台电脑隔多久才许再从桶里下一次。 */
export const claudeDesktopWorkspaceRedeliverMs = 7 * 24 * 60 * 60_000
const defaultRecheckDelaysMs: readonly number[] = [3 * 60_000, 10 * 60_000]
// 没下成以后这么久之内不再下：这次打开后面那几回复查不会把同一份 1.3 GB 再从头下两遍。重启星芒以后照常再试。
export const claudeDesktopWorkspaceRetryCooldownMs = 30 * 60_000
const shaPattern = /^[0-9a-f]{40}$/
const checksumPattern = /^[0-9a-f]{64}$/
const fileNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const stagingNamePattern = /^xingmang-[0-9a-f-]{36}-[A-Za-z0-9._-]{1,64}-zst$/
const markerLimitBytes = 4 * 1024
const stateLimitBytes = 32 * 1024
const deliveredLimit = 32
// 解开后的大小清单里没写时，按压缩的 8 倍估（4.4212.0 的 rootfs.vhdx 是 6 倍、rootfs.img 是 8.6 倍）。
const rawSizeFallbackRatio = 8

class WorkspaceSkip extends Error {
  constructor(readonly reason: ClaudeDesktopWorkspaceSkipReason, message: string, readonly detail?: Record<string, unknown>) {
    super(message)
    this.name = 'WorkspaceSkip'
  }
}

export function claudeDesktopVmPlatformKey(platform: NodeJS.Platform): ClaudeDesktopVmPlatformKey | null {
  if (platform === 'win32') return 'win32'
  if (platform === 'darwin') return 'unix'
  return null
}

/** 桶里一份文件的位置：版本、平台架构、校验值都在路径里，同一个名字永远是同一份内容。 */
export function claudeDesktopWorkspaceObjectKey(sha: string, platformKey: ClaudeDesktopVmPlatformKey, architecture: ClaudeDesktopVmArchitecture, file: Pick<ClaudeDesktopVmFile, 'name' | 'checksum'>): string {
  if (!shaPattern.test(sha) || !checksumPattern.test(file.checksum) || !fileNamePattern.test(file.name) || file.name.includes('..')) {
    throw new Error('工作区版本号、文件名或校验值格式无效')
  }
  return `${claudeDesktopComponentsBucketPrefix}/vm/${sha}/${platformKey}-${architecture}/${file.checksum}/${file.name}.zst`
}

export function claudeDesktopWorkspacePaths(profileDirectory: string, paths: path.PlatformPath = path): ClaudeDesktopWorkspacePaths {
  const bundleDirectory = paths.join(profileDirectory, 'vm_bundles', 'claudevm.bundle')
  return { bundleDirectory, adoptedMarkerPath: paths.join(bundleDirectory, '.cowork-adopted') }
}

export function claudeDesktopWorkspaceFilePaths(bundleDirectory: string, name: string, paths: path.PlatformPath = path): ClaudeDesktopWorkspaceFilePaths {
  if (!fileNamePattern.test(name) || name.includes('..')) throw new Error('工作区文件名格式无效')
  return {
    raw: paths.join(bundleDirectory, name),
    rawOrigin: paths.join(bundleDirectory, `.${name}.origin`),
    cache: paths.join(bundleDirectory, `${name}.zst`),
    cacheOrigin: paths.join(bundleDirectory, `.${name}.zst.origin`),
  }
}

async function readMarker(filePath: string): Promise<string | null> {
  try {
    const stats = await fs.promises.lstat(filePath)
    if (!stats.isFile() || stats.size > markerLimitBytes) return null
    return await fs.promises.readFile(filePath, 'utf8')
  } catch {
    return null
  }
}

async function regularFileSize(filePath: string): Promise<number | null> {
  try {
    const stats = await fs.promises.lstat(filePath)
    return stats.isFile() ? stats.size : null
  } catch {
    return null
  }
}

/**
 * 一个文件在 Claude 眼里是什么状态：ready（解开的那份在、版本号对，跟它的判法一样逐字比）、cached（缓存的压缩包
 * 在、大小对、版本号对，它下次要用会自己解开）、missing。
 */
export async function inspectClaudeDesktopWorkspaceFile(bundleDirectory: string, file: Pick<ClaudeDesktopVmFile, 'name' | 'size'>, sha: string, paths: path.PlatformPath = path): Promise<'ready' | 'cached' | 'missing'> {
  const filePaths = claudeDesktopWorkspaceFilePaths(bundleDirectory, file.name, paths)
  if (await regularFileSize(filePaths.raw) !== null && await readMarker(filePaths.rawOrigin) === sha) return 'ready'
  if (await regularFileSize(filePaths.cache) === file.size && await readMarker(filePaths.cacheOrigin) === sha) return 'cached'
  return 'missing'
}

interface DeliveredEntry {
  key: string
  at: number
}

export function parseDeliveredState(text: string | null): DeliveredEntry[] {
  if (!text) return []
  let parsed: unknown
  try { parsed = JSON.parse(text) as unknown }
  catch { return [] }
  const record = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  if (record?.version !== 1 || !Array.isArray(record.delivered)) return []
  return record.delivered.flatMap((entry: unknown) => {
    const item = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : null
    return item && typeof item.key === 'string' && /^[A-Za-z0-9:._-]{1,200}$/.test(item.key) && typeof item.at === 'number' && Number.isFinite(item.at)
      ? [{ key: item.key, at: item.at }]
      : []
  }).slice(-deliveredLimit)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createClaudeDesktopWorkspaceSeeder(options: ClaudeDesktopWorkspaceSeederOptions): ClaudeDesktopWorkspaceSeeder {
  const paths = options.pathModule ?? path
  const timeoutMs = options.timeoutMs ?? claudeDesktopWorkspaceSeedTimeoutMs
  const now = options.now ?? Date.now
  const readManifest = options.readManifest ?? readClaudeDesktopComponentManifest
  const diskSpace = options.readDiskSpace ?? ((target: string) => readDiskSpace(target))
  const recheckDelays = options.recheckDelaysMs ?? defaultRecheckDelaysMs
  const setTimer = options.setTimer ?? ((callback: () => void, milliseconds: number) => {
    const timer = setTimeout(callback, milliseconds)
    timer.unref?.()
    return { cancel: () => clearTimeout(timer) }
  })
  const statePath = path.join(options.stateDirectory, 'delivered.json')
  const manifests = new Map<string, { stamp: string; manifest: ClaudeDesktopComponentManifest }>()
  const reportedReady = new Set<string>()
  const timers = new Set<{ cancel(): void }>()
  const failedAt = new Map<string, number>()
  let inFlight: Promise<ClaudeDesktopWorkspaceSeedOutcome> | null = null
  let disposed = false

  function log(level: 'info' | 'warn', event: string, message: string, detail?: Record<string, unknown>): void {
    try { options.log?.(level, event, message, detail) }
    catch { /* 记日志失败不影响放工作区。 */ }
  }

  function redact(value: string): string {
    return redactHomeDirectory(value, options.userHome, options.platform)
  }

  async function manifestFor(asarPath: string): Promise<ClaudeDesktopComponentManifest> {
    let stats: fs.Stats
    try { stats = await fs.promises.stat(asarPath) }
    catch (error) {
      throw new WorkspaceSkip('asar-unreadable', '读不到 Claude Desktop 的程序文件', { asar: redact(asarPath), code: (error as NodeJS.ErrnoException).code })
    }
    const stamp = `${stats.size}:${stats.mtimeMs}`
    const cached = manifests.get(asarPath)
    if (cached?.stamp === stamp) return cached.manifest
    let manifest: ClaudeDesktopComponentManifest
    try { manifest = await readManifest(asarPath) }
    catch (error) {
      throw new WorkspaceSkip('asar-unreadable', '读不出 Claude Desktop 要的工作区版本', { asar: redact(asarPath), cause: errorMessage(error) })
    }
    manifests.set(asarPath, { stamp, manifest })
    return manifest
  }

  function readDelivered(): DeliveredEntry[] {
    try { return parseDeliveredState(readSafeUtf8FileSync(statePath, '工作区下载记录', stateLimitBytes)) }
    catch { return [] }
  }

  async function recordDelivered(key: string): Promise<void> {
    const entries = [...readDelivered().filter((entry) => entry.key !== key), { key, at: now() }].slice(-deliveredLimit)
    try {
      ensureSafeDataDirectory(options.stateDirectory, '工作区下载记录')
      await writeAtomicSafeUtf8File(statePath, `${JSON.stringify({ version: 1, delivered: entries })}\n`, '工作区下载记录')
    } catch (error) {
      log('warn', 'claude-desktop.workspace-seed.state-failed', '记不下工作区已经下过，下次可能再下一次', { cause: redact(errorMessage(error)) })
    }
  }

  function deliveryKey(sha: string, platformKey: ClaudeDesktopVmPlatformKey, architecture: ClaudeDesktopVmArchitecture, bundleDirectory: string): string {
    const where = createHash('sha256').update(bundleDirectory).digest('hex').slice(0, 16)
    return `workspace:${sha}:${platformKey}-${architecture}:${where}`
  }

  /** 上回没下完（星芒中途被关）留下的临时文件：只认我们自己起的名字。 */
  async function removeStaleStaging(bundleDirectory: string): Promise<void> {
    let names: string[]
    try { names = await fs.promises.readdir(bundleDirectory) }
    catch { return }
    for (const name of names.filter((entry) => stagingNamePattern.test(entry)).slice(0, 16)) {
      await removeSafeDataFile(paths.join(bundleDirectory, name), '工作区临时文件').catch(() => undefined)
    }
  }

  async function downloadFile(url: string, stagingPath: string, file: ClaudeDesktopVmFile, signal: AbortSignal, onBytes: (transferred: number) => void): Promise<void> {
    const result = await downloadWithResume({
      targetPath: stagingPath,
      fileMode: 0o600,
      maximumBytes: file.size,
      oversizeMessage: '工作区文件比 Claude 清单里写的大',
      signal,
      responseTimeoutMs: 30_000,
      idleTimeoutMs: 60_000,
      maximumResumes: 30,
      ...(options.resumeDelaysMs ? { resumeDelaysMs: options.resumeDelaysMs } : {}),
      request: (headers, requestSignal) => fetchDesktopBucketResource(url, { headers: { Accept: 'application/octet-stream', ...headers }, signal: requestSignal }, options.fetch),
      acceptResponse: (response) => {
        if (response.status !== 200) throw new Error(`HTTP ${response.status}`)
        const declared = response.headers.get('content-length')
        if (declared !== null && Number(declared) !== file.size) throw new Error('存储桶里的工作区文件大小跟 Claude 清单对不上')
        return file.size
      },
      onProgress: (transferred) => onBytes(transferred),
    })
    if (result.size !== file.size || result.sha256.toString('hex') !== file.checksum) {
      throw new Error('存储桶里的工作区文件跟 Claude 清单里的校验值对不上')
    }
  }

  async function placeFile(bundleDirectory: string, file: ClaudeDesktopVmFile, sha: string, stagingPath: string): Promise<void> {
    const label = 'Claude 工作区'
    const filePaths = claudeDesktopWorkspaceFilePaths(bundleDirectory, file.name, paths)
    // 跟它自己放缓存的顺序一样：先撤掉旧的版本号，再换压缩包，最后写版本号。
    await removeSafeDataFile(filePaths.cacheOrigin, label)
    await renameWithTransientRetry(stagingPath, filePaths.cache, () => {
      assertNoReparseComponents(bundleDirectory, label)
      assertSafeDataFile(filePaths.cache, label)
    })
    await writeAtomicSafeUtf8File(filePaths.cacheOrigin, sha, label)
  }

  async function seedNow(clientPath: string): Promise<ClaudeDesktopWorkspaceSeedOutcome> {
    const platformKey = claudeDesktopVmPlatformKey(options.platform)
    if (!platformKey) throw new WorkspaceSkip('unsupported-platform', '这个系统上 Claude Desktop 没有工作区')
    if (options.platform === 'win32' && options.executionMode !== 'same-user') throw new WorkspaceSkip('not-same-user', '星芒正以管理员身份运行，不往 Claude Desktop 的文件夹里写东西')
    if (options.isOff?.() === true) throw new WorkspaceSkip('remote-off', '替 Claude Desktop 放工作区已被远程关掉')
    let target: ClaudeDesktopComponentTarget | null
    try { target = await options.resolveTarget(clientPath) }
    catch (error) {
      throw new WorkspaceSkip('target-unresolved', '找不到 Claude Desktop 的数据目录', { cause: redact(errorMessage(error)) })
    }
    if (!target) throw new WorkspaceSkip('target-unresolved', '找不到 Claude Desktop 的数据目录')
    const manifest = await manifestFor(target.asarPath)
    if (!manifest.vm) throw new WorkspaceSkip('manifest-not-found', 'Claude Desktop 程序里没找到工作区清单，可能它换了写法', { asar: redact(target.asarPath) })
    const files = manifest.vm.files[platformKey][target.architecture]
    if (!files?.length) throw new WorkspaceSkip('architecture-missing', 'Claude Desktop 的工作区清单里没有这台电脑的', { platform: platformKey, architecture: target.architecture })
    const sha = manifest.vm.sha
    const { bundleDirectory, adoptedMarkerPath } = claudeDesktopWorkspacePaths(target.profileDirectory, paths)
    // 它要了才下：这台电脑跑不了虚拟机、客户也从没点过 Cowork 的，一个字节都不下。
    if (await regularFileSize(adoptedMarkerPath) === null) throw new WorkspaceSkip('not-adopted', 'Claude Desktop 还没要过工作区，这次不下')

    // 虚拟机里那份 Linux 版 Claude Code 先放（小、来源是 npm 国内镜像，不占桶的流量）。
    if (options.linuxCode) {
      await options.linuxCode.seed({ profileDirectory: target.profileDirectory, architecture: target.architecture, pins: manifest.code }).catch(() => undefined)
    }

    const states = await Promise.all(files.map((file) => inspectClaudeDesktopWorkspaceFile(bundleDirectory, file, sha, paths)))
    const missing = files.filter((_, index) => states[index] === 'missing')
    if (missing.length === 0) {
      if (!reportedReady.has(sha)) {
        reportedReady.add(sha)
        log('info', 'claude-desktop.workspace-seed.ready', 'Claude Desktop 的工作区已经在了', { sha: sha.slice(0, 12), cached: states.filter((state) => state === 'cached').length })
      }
      return { status: 'ready', sha }
    }
    const key = deliveryKey(sha, platformKey, target.architecture, bundleDirectory)
    const previous = readDelivered().find((entry) => entry.key === key)
    if (previous && now() - previous.at < claudeDesktopWorkspaceRedeliverMs && previous.at <= now()) {
      throw new WorkspaceSkip('recently-delivered', '这一版工作区这台电脑最近已经从下载站下过，Claude 没用上，这次不再下', { sha: sha.slice(0, 12) })
    }
    const lastFailure = failedAt.get(key)
    if (lastFailure !== undefined && now() - lastFailure < claudeDesktopWorkspaceRetryCooldownMs && lastFailure <= now()) {
      throw new WorkspaceSkip('recently-failed', '刚才从下载站下工作区没下成，过一阵再试', { sha: sha.slice(0, 12) })
    }
    const total = missing.reduce((sum, file) => sum + file.size, 0)
    const needed = missing.reduce((sum, file) => sum + file.size + (file.rawSize ?? file.size * rawSizeFallbackRatio), 0) + installMinimumFreeBytes
    const space = await diskSpace(target.profileDirectory).catch(() => null)
    // 读不到空间照样放行（disk-space.ts 的 fail-open）；读得到就要够放压缩包加 Claude 解开后的那份。
    if (space && space.availableBytes < needed) {
      throw new WorkspaceSkip('disk-space', '盘上空间不够放 Claude 的工作区，这次不下', { availableBytes: space.availableBytes, neededBytes: needed })
    }
    try {
      ensureSafeDataDirectory(bundleDirectory, 'Claude 工作区')
    } catch (error) {
      throw new WorkspaceSkip('write-failed', '进不了 Claude Desktop 放工作区的文件夹', { cause: redact(errorMessage(error)) })
    }
    await removeStaleStaging(bundleDirectory)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
    timer.unref?.()
    const startedAt = now()
    let done = 0
    const stagingPaths: string[] = []
    try {
      log('info', 'claude-desktop.workspace-seed.started', '开始从下载站替 Claude Desktop 下工作区', { sha: sha.slice(0, 12), files: missing.length, bytes: total })
      for (const file of missing) {
        // 远程开关在下的中途关上：手上这个文件下完就停，后面的不再下。
        if (done > 0 && options.isOff?.() === true) throw new WorkspaceSkip('remote-off', '替 Claude Desktop 放工作区已被远程关掉，剩下的不再下', { sha: sha.slice(0, 12), transferred: done })
        const stagingPath = paths.join(bundleDirectory, `xingmang-${randomUUID()}-${file.name}-zst`)
        stagingPaths.push(stagingPath)
        const url = `${desktopPackageBucketOrigin}/${claudeDesktopWorkspaceObjectKey(sha, platformKey, target.architecture, file)}`
        try {
          await downloadFile(url, stagingPath, file, controller.signal, (transferred) => {
            try { options.onProgress?.({ sha, transferred: done + transferred, total }) }
            catch { /* 界面断开了不影响下载。 */ }
          })
        } catch (error) {
          failedAt.set(key, now())
          if (controller.signal.aborted) throw new WorkspaceSkip('timeout', '下工作区超过了等待时长，先停下，下次打开再下', { sha: sha.slice(0, 12), transferred: done })
          throw new WorkspaceSkip('download-failed', '从下载站下工作区没下成', {
            sha: sha.slice(0, 12), file: file.name, cause: error instanceof DownloadStalledError ? '下载中途没有新数据' : errorMessage(error),
          })
        }
        // 下的这一阵 Claude 可能自己下好了（或者有人放了）：好了就不换它的。
        if (await inspectClaudeDesktopWorkspaceFile(bundleDirectory, file, sha, paths) === 'missing') {
          try { await placeFile(bundleDirectory, file, sha, stagingPath) }
          catch (error) {
            throw new WorkspaceSkip('write-failed', '没能把工作区放进 Claude Desktop 的文件夹', { file: file.name, cause: redact(errorMessage(error)) })
          }
        }
        done += file.size
      }
      await recordDelivered(key)
      log('info', 'claude-desktop.workspace-seed.placed', '已替 Claude Desktop 放好工作区，它下次用时自己解开核对', {
        sha: sha.slice(0, 12), files: missing.length, bytes: total, ms: now() - startedAt,
      })
      try { options.onPlaced?.({ sha, files: missing.length, bytes: total }) }
      catch { /* 提醒发不出去不影响已经放好的工作区。 */ }
      return { status: 'placed', sha, files: missing.length, bytes: total }
    } finally {
      clearTimeout(timer)
      for (const stagingPath of stagingPaths) await fs.promises.rm(stagingPath, { force: true }).catch(() => undefined)
    }
  }

  function seed(clientPath: string): Promise<ClaudeDesktopWorkspaceSeedOutcome> {
    if (inFlight) return inFlight
    const pending = seedNow(clientPath).catch((error: unknown): ClaudeDesktopWorkspaceSeedOutcome => {
      if (error instanceof WorkspaceSkip) {
        // 这几样是「本来就不该做」，不是出了岔子。
        const quiet = ['unsupported-platform', 'not-same-user', 'remote-off', 'not-adopted', 'recently-delivered', 'recently-failed'].includes(error.reason)
        log(quiet ? 'info' : 'warn', 'claude-desktop.workspace-seed.skipped', error.message, { reason: error.reason, ...error.detail })
        return { status: 'skipped', reason: error.reason }
      }
      log('warn', 'claude-desktop.workspace-seed.skipped', '替 Claude Desktop 放工作区没成', { reason: 'write-failed', cause: redact(errorMessage(error)) })
      return { status: 'skipped', reason: 'write-failed' }
    })
    inFlight = pending
    void pending.finally(() => { if (inFlight === pending) inFlight = null })
    return pending
  }

  return {
    seed,
    scheduleAfterLaunch(clientPath) {
      if (disposed || claudeDesktopVmPlatformKey(options.platform) === null) return
      // 连点几次「打开」只留最后一轮复查。
      for (const handle of timers) handle.cancel()
      timers.clear()
      void seed(clientPath)
      for (const delay of recheckDelays) {
        const handle = setTimer(() => {
          timers.delete(handle)
          if (!disposed) void seed(clientPath)
        }, delay)
        timers.add(handle)
      }
    },
    dispose() {
      disposed = true
      for (const handle of timers) handle.cancel()
      timers.clear()
    },
  }
}

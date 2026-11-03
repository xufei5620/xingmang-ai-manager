/**
 * Mac 上从星芒打开 Claude Desktop 前，替它把 Claude Code 程序放好（yoyo 2026-11-03「如果能用这个方式就不要加速了」；
 * 方案 /mnt/project-files/加速下线/Claude工作区和Mac-存储桶方案-1103.md）。Windows 那一半在 claude-desktop-code-seed.ts。
 *
 * Mac 跟 Windows 不一样：它装的不是 npm 上那个文件，是官网的「程序包」`claude.app.tar.zst`（带 Anthropic 签名的
 * 小 .app，里面那个 claude 跟 npm 的 darwin 包不是同一个文件，探测 41624912418 实比过），所以只能从官网搬进
 * 星芒的存储桶，再从桶里下。拆 4.4212.0 看到它自己是这样装的（downloadBundleForTarget / F4r / I4r）：
 * - 下 `<版本>/darwin-<架构>/claude.app.tar.zst`，核压缩包的 sha256（清单里 `bundle.checksum`）；
 * - 在 `<userData>/claude-code/<版本>/` 下建临时目录解开，删掉旧的 `<编号>/`，整个改名成 `<编号>/`
 *   （编号 = 压缩包 sha256 前 12 位），最后写 `<编号>/.verified` = 完整的 sha256；
 * - 启动时认：`claude.app/Contents/MacOS/claude` 能执行、`.verified` trim 后对得上、Mach-O 头是这台机器的架构。
 *
 * 包里只有 4 个目录、4 个普通文件（探测 41624912418 列过：Info.plist、MacOS/claude、两份 CodeResources），
 * 所以这里只认目录和普通文件，链接、设备文件、`..`、绝对路径一律拒收，拒了就照常打开、让它自己去官网下。
 * 版本、校验值都取自客户电脑上已经装好的那份 Claude 自己的程序：桶里的东西对不上就扔掉。
 *
 * Mac 上本程序从不提权（T5），写的是当前用户自己的 Application Support；照样走 safe-local-data 那套查链接的写法。
 */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import zlib from 'node:zlib'
import { parsePaxRecords, type ClaudeDesktopSeedClient } from './claude-desktop-code-seed'
import {
  readClaudeDesktopComponentManifest,
  type ClaudeCodeMacPlatform,
  type ClaudeCodePackagePin,
  type ClaudeDesktopComponentManifest,
  type ClaudeDesktopVmArchitecture,
} from './claude-desktop-component-manifest'
import { claudeDesktopComponentsBucketPrefix, type ClaudeDesktopComponentTarget } from './claude-desktop-workspace-seed'
import { desktopPackageBucketOrigin, fetchDesktopBucketResource } from './desktop-package-bucket'
import { installMinimumFreeBytes, readDiskSpace, type DiskSpaceReading } from './disk-space'
import { downloadWithResume, DownloadStalledError } from './download-retry'
import {
  assertNoReparseComponents, assertSafeDataFile, ensureSafeDataDirectory, removeSafeDataFile, renameWithTransientRetry,
  writeAtomicSafeUtf8File,
} from './safe-local-data'
import { redactHomeDirectory } from './startup-log'

export type ClaudeDesktopMacCodeSkipReason =
  | 'unsupported-platform'
  | 'remote-off'
  | 'running'
  | 'target-unresolved'
  | 'asar-unreadable'
  | 'pin-not-found'
  | 'disk-space'
  | 'download-failed'
  | 'started-meanwhile'
  | 'extract-failed'
  | 'write-failed'
  | 'timeout'

export type ClaudeDesktopMacCodeSeedOutcome =
  | { status: 'present'; version: string }
  | { status: 'placed'; version: string }
  | { status: 'skipped'; reason: ClaudeDesktopMacCodeSkipReason }

export interface ClaudeCodeMacPin extends ClaudeCodePackagePin {
  version: string
  platform: ClaudeCodeMacPlatform
}

export interface ClaudeCodeMacSeedPaths {
  /** `<userData>/claude-code/<版本>`：Claude 在这一层建临时目录解包。 */
  versionDirectory: string
  /** `<userData>/claude-code/<版本>/<编号>`。 */
  installDirectory: string
  binaryPath: string
  verifiedPath: string
}

export interface ClaudeDesktopMacCodeProgress {
  phase: 'downloading' | 'placing'
  version: string
  transferred: number
  total: number
}

export interface ClaudeDesktopMacCodeSeederOptions {
  platform: NodeJS.Platform
  /** 下载用的 fetch（system-service 传接好系统代理的那个）。 */
  fetch: typeof fetch
  /** 认出这份 Claude 的数据目录、程序文件和架构（跟放工作区那边共用一个）；认不出给 null。 */
  resolveTarget(clientPath: string): Promise<ClaudeDesktopComponentTarget | null>
  userHome: string
  /** 远程开关关了这件事（remote-features.ts 的 claude-desktop-code-seed，跟 Windows 那一半共用）。 */
  isOff?(): boolean
  readManifest?(asarPath: string): Promise<ClaudeDesktopComponentManifest>
  readDiskSpace?(target: string): Promise<DiskSpaceReading | null>
  /** 每次最多等多久，缺省 claudeDesktopMacCodeSeedTimeoutMs。 */
  timeoutMs?: number
  onProgress?(event: ClaudeDesktopMacCodeProgress): void
  log?(level: 'info' | 'warn', event: string, message: string, detail?: Record<string, unknown>): void
  now?(): number
  resumeDelaysMs?: readonly number[]
}

export interface ClaudeDesktopMacCodeSeeder {
  /** 永不抛错：调用方拿到什么结果都照常打开 Claude。 */
  prepare(client: ClaudeDesktopSeedClient): Promise<ClaudeDesktopMacCodeSeedOutcome>
}

/** 一次最多等多久：包约 93 MB，上海的桶国内一般一两分钟；再慢就先照常打开，下次打开再放。 */
export const claudeDesktopMacCodeSeedTimeoutMs = 15 * 60_000

const checksumPattern = /^[0-9a-f]{64}$/
const versionPattern = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/
const buildIdLength = 12
const appRootName = 'claude.app'
const binaryRelativePath = ['claude.app', 'Contents', 'MacOS', 'claude']
const segmentPattern = /^[A-Za-z0-9._ +@-]{1,128}$/
const tarBlock = 512
const tarEntryLimit = 256
const tarDepthLimit = 12
const tarMetadataLimitBytes = 64 * 1024
// 2.1.309 的程序解开 263 MB；Windows 那边同一道顶是 1 GB。
const bundleExtractedLimitBytes = 1024 * 1024 * 1024
const binaryMinimumBytes = 1024 * 1024
const archiveLimitBytes = 768 * 1024 * 1024
const markerLimitBytes = 4 * 1024
const runningProbeTimeoutMs = 20_000
// 解开后的大小清单里没写：按压缩包的 4 倍估（2.1.309 是 2.8 倍）。
const extractedSizeFallbackRatio = 4
const stagingNamePattern = /^xingmang-(?:extract-[0-9a-f-]{36}|[0-9a-f-]{36}\.tar\.zst)$/
// Mach-O 的几个魔数和处理器类型，跟 Claude 自己那段（_4r）一样认：胖二进制（大端 0xcafebabe / 0xcafebabf）直接放行，
// 64 位小端 0xfeedfacf 再看处理器类型。
const machoFatMagic = 0xcafebabe
const machoFatMagic64 = 0xcafebabf
const machoMagic64 = 0xfeedfacf
const machoCpuType: Record<ClaudeDesktopVmArchitecture, number> = { x64: 0x01000007, arm64: 0x0100000c }

class MacSeedSkip extends Error {
  constructor(readonly reason: ClaudeDesktopMacCodeSkipReason, message: string, readonly detail?: Record<string, unknown>) {
    super(message)
    this.name = 'MacSeedSkip'
  }
}

/** Claude 清单里这台 Mac 要的那一份程序包；版本号或校验值不像样就当没有。 */
export function resolveClaudeCodeMacPin(manifest: ClaudeDesktopComponentManifest, architecture: ClaudeDesktopVmArchitecture): ClaudeCodeMacPin | null {
  const code = manifest.code
  if (!code || !versionPattern.test(code.version)) return null
  const platform: ClaudeCodeMacPlatform = architecture === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
  const bundle = code.macBundles[platform]
  if (!bundle || !checksumPattern.test(bundle.checksum) || !Number.isSafeInteger(bundle.size) || bundle.size <= 0 || bundle.size > archiveLimitBytes) return null
  return { version: code.version, platform, checksum: bundle.checksum, size: bundle.size }
}

/** 桶里那一份的位置：版本、平台、校验值都在路径里，同一个名字永远是同一份内容。 */
export function claudeCodeMacObjectKey(pin: Pick<ClaudeCodeMacPin, 'version' | 'platform' | 'checksum'>): string {
  if (!versionPattern.test(pin.version) || !checksumPattern.test(pin.checksum) || (pin.platform !== 'darwin-arm64' && pin.platform !== 'darwin-x64')) {
    throw new Error('Claude Code 版本号、平台或校验值格式无效')
  }
  return `${claudeDesktopComponentsBucketPrefix}/code/${pin.version}/${pin.platform}/${pin.checksum}/claude.app.tar.zst`
}

export function claudeCodeMacSeedPaths(profileDirectory: string, pin: Pick<ClaudeCodeMacPin, 'version' | 'checksum'>, paths: path.PlatformPath = path.posix): ClaudeCodeMacSeedPaths {
  if (!versionPattern.test(pin.version) || !checksumPattern.test(pin.checksum)) throw new Error('Claude Code 版本号或校验值格式无效')
  const versionDirectory = paths.join(profileDirectory, 'claude-code', pin.version)
  const installDirectory = paths.join(versionDirectory, pin.checksum.slice(0, buildIdLength))
  return {
    versionDirectory,
    installDirectory,
    binaryPath: paths.join(installDirectory, ...binaryRelativePath),
    verifiedPath: paths.join(installDirectory, '.verified'),
  }
}

/** 跟 Claude 启动时那道 Mach-O 检查一样：不是这台 Mac 能跑的程序，它会当没装、自己再去官网下。 */
export async function inspectMachOHeader(filePath: string, architecture: ClaudeDesktopVmArchitecture): Promise<'ok' | 'not-macho' | 'arch-mismatch'> {
  let handle: fs.promises.FileHandle | null = null
  try {
    handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    const header = Buffer.alloc(8)
    const { bytesRead } = await handle.read(header, 0, 8, 0)
    if (bytesRead < 8) return 'not-macho'
    const bigEndian = header.readUInt32BE(0)
    if (bigEndian === machoFatMagic || bigEndian === machoFatMagic64) return 'ok'
    if (header.readUInt32LE(0) !== machoMagic64) return 'not-macho'
    return header.readUInt32LE(4) === machoCpuType[architecture] ? 'ok' : 'arch-mismatch'
  } catch {
    return 'not-macho'
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function readSmallFile(filePath: string): Promise<string | null> {
  try {
    const stats = await fs.promises.lstat(filePath)
    if (!stats.isFile() || stats.size > markerLimitBytes) return null
    return await fs.promises.readFile(filePath, 'utf8')
  } catch {
    return null
  }
}

async function isExecutableFile(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.promises.lstat(filePath)
    return stats.isFile() && (stats.mode & 0o111) !== 0
  } catch {
    return false
  }
}

/** Claude 启动时会认的那一份在不在：程序能执行、`.verified` 对得上、Mach-O 头是这台机器的。 */
export async function inspectClaudeCodeMacSeed(seedPaths: ClaudeCodeMacSeedPaths, checksum: string, architecture: ClaudeDesktopVmArchitecture): Promise<'present' | 'missing'> {
  if ((await readSmallFile(seedPaths.verifiedPath))?.trim() !== checksum) return 'missing'
  if (!await isExecutableFile(seedPaths.binaryPath)) return 'missing'
  return await inspectMachOHeader(seedPaths.binaryPath, architecture) === 'ok' ? 'present' : 'missing'
}

/** tar 里的一条路径拆成几段：只许 `claude.app` 底下、每段都是普通名字，`.`、`..`、空段、反斜杠一律不认。 */
export function parseClaudeAppBundleEntryPath(name: string): string[] | null {
  const trimmed = name.endsWith('/') ? name.slice(0, -1) : name
  if (!trimmed || trimmed.startsWith('/') || trimmed.includes('\\') || trimmed.includes('\0')) return null
  const segments = trimmed.split('/')
  if (segments[0] !== appRootName || segments.length > tarDepthLimit) return null
  for (const segment of segments) {
    if (segment === '.' || segment === '..' || !segmentPattern.test(segment)) return null
  }
  return segments
}

function tarString(block: Buffer, start: number, length: number): string {
  const slice = block.subarray(start, start + length)
  const end = slice.indexOf(0)
  return slice.subarray(0, end < 0 ? slice.length : end).toString('utf8')
}

function tarNumber(block: Buffer, start: number, length: number): number | null {
  const raw = tarString(block, start, length).trim()
  if (!/^[0-7]{1,12}$/.test(raw)) return raw === '' ? 0 : null
  const value = Number.parseInt(raw, 8)
  return Number.isSafeInteger(value) ? value : null
}

function tarChecksumValid(block: Buffer): boolean {
  const recorded = tarNumber(block, 148, 8)
  if (recorded === null) return false
  let sum = 0
  for (let index = 0; index < tarBlock; index += 1) sum += index >= 148 && index < 156 ? 0x20 : block[index]
  return sum === recorded
}

export interface ClaudeAppBundleExtraction {
  files: number
  directories: number
  bytes: number
}

/**
 * 边解压边把 `claude.app` 整个解进 `targetDirectory`（调用方刚建的空目录）。只认目录、普通文件和 pax / 长名字
 * 扩展头；链接、设备、别的怪类型，路径越出 `claude.app`、同一个文件出现两次、条目太多、总量超限，一律报错。
 * 文件一律新建（已有同名就报错），权限只留「能不能执行」这一位：0755 或 0644。
 */
export async function extractClaudeAppBundle(
  source: AsyncIterable<Buffer | Uint8Array | string>,
  targetDirectory: string,
  maximumBytes: number = bundleExtractedLimitBytes,
): Promise<ClaudeAppBundleExtraction> {
  let pending = Buffer.alloc(0)
  let state: 'header' | 'body' | 'meta' | 'end' = 'header'
  let remaining = 0
  let padding = 0
  let metaKind: 'pax' | 'longname' | 'skip' = 'skip'
  let meta: Buffer[] = []
  let metaBytes = 0
  let nextPath: string | undefined
  let nextSize: number | undefined
  let entries = 0
  let zeroBlocks = 0
  let consumed = 0
  let bytes = 0
  let files = 0
  let directories = 0
  let handle: fs.promises.FileHandle | null = null
  const written = new Set<string>()
  const totalLimit = maximumBytes + tarEntryLimit * (tarMetadataLimitBytes + tarBlock * 2) + 16 * 1024 * 1024

  async function startEntry(block: Buffer): Promise<void> {
    if (!tarChecksumValid(block)) throw new Error('程序包里的文件头校验不对')
    entries += 1
    if (entries > tarEntryLimit) throw new Error('程序包里的文件太多')
    const type = String.fromCharCode(block[156] || 0x30)
    const prefix = tarString(block, 345, 155)
    const baseName = tarString(block, 0, 100)
    const name = nextPath ?? (prefix ? `${prefix}/${baseName}` : baseName)
    const declared = nextSize ?? tarNumber(block, 124, 12)
    nextPath = undefined
    nextSize = undefined
    if (declared === null || declared < 0) throw new Error('程序包里的文件大小读不出来')
    remaining = declared
    padding = (tarBlock - (declared % tarBlock)) % tarBlock
    if (type === 'x' || type === 'L' || type === 'g') {
      if (declared > tarMetadataLimitBytes) throw new Error('程序包里的扩展头太大')
      metaKind = type === 'x' ? 'pax' : type === 'L' ? 'longname' : 'skip'
      meta = []
      metaBytes = 0
      state = remaining > 0 ? 'meta' : 'header'
      if (remaining === 0 && padding === 0) finishMeta()
      return
    }
    const segments = parseClaudeAppBundleEntryPath(name)
    if (!segments) throw new Error('程序包里有不该有的路径')
    const target = path.join(targetDirectory, ...segments)
    if (type === '5') {
      if (declared !== 0) throw new Error('程序包里的目录带了内容')
      await fs.promises.mkdir(target, { recursive: true, mode: 0o755 })
      directories += 1
      state = 'header'
      return
    }
    if (type !== '0' && type !== '\0') throw new Error('程序包里有链接或别的特殊文件')
    const key = segments.join('/')
    if (written.has(key)) throw new Error('程序包里有两个同名的文件')
    written.add(key)
    if (segments.length < 2) throw new Error('程序包里的程序目录不是目录')
    bytes += declared
    if (bytes > maximumBytes) throw new Error('程序包解开后超过安全上限')
    await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o755 })
    const mode = (tarNumber(block, 100, 8) ?? 0) & 0o111 ? 0o755 : 0o644
    handle = await fs.promises.open(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), mode)
    // umask 可能把执行位抹掉：Claude 启动时要的就是能执行。
    await handle.chmod(mode)
    files += 1
    state = remaining > 0 || padding > 0 ? 'body' : 'header'
    if (state === 'header') await closeFile()
  }

  function finishMeta(): void {
    const content = Buffer.concat(meta)
    if (metaKind === 'pax') {
      const records = parsePaxRecords(content)
      if (!records) throw new Error('程序包里的扩展头读不出来')
      nextPath = records.path ?? nextPath
      nextSize = records.size ?? nextSize
    } else if (metaKind === 'longname') {
      const end = content.indexOf(0)
      nextPath = content.subarray(0, end < 0 ? content.length : end).toString('utf8')
    }
    meta = []
    metaBytes = 0
  }

  async function closeFile(): Promise<void> {
    const current = handle
    handle = null
    await current?.close()
  }

  async function write(part: Buffer): Promise<void> {
    if (!handle) return
    let offset = 0
    while (offset < part.length) {
      const { bytesWritten } = await handle.write(part, offset, part.length - offset)
      if (bytesWritten <= 0) throw new Error('写不进程序包里的文件')
      offset += bytesWritten
    }
  }

  try {
    for await (const raw of source) {
      let chunk: Buffer = typeof raw === 'string' ? Buffer.from(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
      consumed += chunk.length
      if (consumed > totalLimit) throw new Error('程序包解开后超过安全上限')
      while (chunk.length > 0 && state !== 'end') {
        if (state === 'header') {
          const need = tarBlock - pending.length
          pending = Buffer.concat([pending, chunk.subarray(0, need)])
          chunk = chunk.subarray(need)
          if (pending.length < tarBlock) break
          const block = pending
          pending = Buffer.alloc(0)
          if (block.every((byte) => byte === 0)) {
            zeroBlocks += 1
            if (zeroBlocks >= 2) state = 'end'
            continue
          }
          zeroBlocks = 0
          await startEntry(block)
          continue
        }
        if (remaining > 0) {
          const take = Math.min(remaining, chunk.length)
          const part = chunk.subarray(0, take)
          chunk = chunk.subarray(take)
          remaining -= take
          if (state === 'meta') {
            metaBytes += part.length
            if (metaBytes > tarMetadataLimitBytes) throw new Error('程序包里的扩展头太大')
            meta.push(Buffer.from(part))
          } else {
            await write(part)
          }
          if (remaining > 0) continue
        }
        if (padding > 0) {
          const skip = Math.min(padding, chunk.length)
          chunk = chunk.subarray(skip)
          padding -= skip
          if (padding > 0) continue
        }
        if (state === 'meta') finishMeta()
        else await closeFile()
        state = 'header'
      }
    }
    // 要读到结尾那两个空块才算完：在两个条目之间断掉的包，前面几样解得出来，后面的就悄悄少了。
    if (state !== 'end') throw new Error('程序包不完整')
  } finally {
    await closeFile().catch(() => undefined)
  }
  return { files, directories, bytes }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function withTimeout<T>(operation: Promise<T>, milliseconds: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), milliseconds)
    timer.unref?.()
    operation.then((value) => { clearTimeout(timer); resolve(value) }, () => { clearTimeout(timer); resolve(fallback) })
  })
}

/** 一个目录（不是链接）整个删掉；路径上任何一级是链接都不删。 */
async function removeSafeDirectory(directory: string, label: string): Promise<void> {
  assertNoReparseComponents(directory, label)
  let stats: fs.Stats
  try { stats = await fs.promises.lstat(directory) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`${label}不是普通目录`)
  await fs.promises.rm(directory, { recursive: true, force: true })
}

export function createClaudeDesktopMacCodeSeeder(options: ClaudeDesktopMacCodeSeederOptions): ClaudeDesktopMacCodeSeeder {
  const timeoutMs = options.timeoutMs ?? claudeDesktopMacCodeSeedTimeoutMs
  const now = options.now ?? Date.now
  const readManifest = options.readManifest ?? readClaudeDesktopComponentManifest
  const diskSpace = options.readDiskSpace ?? ((target: string) => readDiskSpace(target))
  const manifests = new Map<string, { stamp: string; manifest: ClaudeDesktopComponentManifest }>()
  const reportedPresent = new Set<string>()
  let inFlight: Promise<ClaudeDesktopMacCodeSeedOutcome> | null = null

  function log(level: 'info' | 'warn', event: string, message: string, detail?: Record<string, unknown>): void {
    try { options.log?.(level, event, message, detail) }
    catch { /* 记日志失败不能挡住打开。 */ }
  }

  function redact(value: string): string {
    return redactHomeDirectory(value, options.userHome, 'darwin')
  }

  function progress(event: ClaudeDesktopMacCodeProgress): void {
    try { options.onProgress?.(event) }
    catch { /* 界面断开了不影响放程序。 */ }
  }

  async function manifestFor(asarPath: string): Promise<ClaudeDesktopComponentManifest> {
    let stats: fs.Stats
    try { stats = await fs.promises.stat(asarPath) }
    catch (error) {
      throw new MacSeedSkip('asar-unreadable', '读不到 Claude Desktop 的程序文件', { asar: redact(asarPath), code: (error as NodeJS.ErrnoException).code })
    }
    const stamp = `${stats.size}:${stats.mtimeMs}`
    const cached = manifests.get(asarPath)
    if (cached?.stamp === stamp) return cached.manifest
    let manifest: ClaudeDesktopComponentManifest
    try { manifest = await readManifest(asarPath) }
    catch (error) {
      throw new MacSeedSkip('asar-unreadable', '读不出 Claude Desktop 要的 Claude Code 版本', { asar: redact(asarPath), cause: errorMessage(error) })
    }
    manifests.set(asarPath, { stamp, manifest })
    return manifest
  }

  /** 上回没放完（星芒中途被关）留下的临时文件和目录：只认我们自己起的名字。 */
  async function removeStaleStaging(versionDirectory: string): Promise<void> {
    let names: string[]
    try { names = await fs.promises.readdir(versionDirectory) }
    catch { return }
    for (const name of names.filter((entry) => stagingNamePattern.test(entry)).slice(0, 16)) {
      const target = path.join(versionDirectory, name)
      if (name.endsWith('.tar.zst')) await removeSafeDataFile(target, 'Claude Code 临时文件').catch(() => undefined)
      else await removeSafeDirectory(target, 'Claude Code 临时目录').catch(() => undefined)
    }
  }

  async function download(pin: ClaudeCodeMacPin, archivePath: string, signal: AbortSignal): Promise<void> {
    const url = `${desktopPackageBucketOrigin}/${claudeCodeMacObjectKey(pin)}`
    const result = await downloadWithResume({
      targetPath: archivePath,
      fileMode: 0o600,
      maximumBytes: pin.size,
      oversizeMessage: '程序包比 Claude 清单里写的大',
      signal,
      responseTimeoutMs: 30_000,
      idleTimeoutMs: 45_000,
      ...(options.resumeDelaysMs ? { resumeDelaysMs: options.resumeDelaysMs } : {}),
      request: (headers, requestSignal) => fetchDesktopBucketResource(url, { headers: { Accept: 'application/octet-stream', ...headers }, signal: requestSignal }, options.fetch),
      acceptResponse: (response) => {
        if (response.status !== 200) throw new Error(`HTTP ${response.status}`)
        const declared = response.headers.get('content-length')
        if (declared !== null && Number(declared) !== pin.size) throw new Error('存储桶里的程序包大小跟 Claude 清单对不上')
        return pin.size
      },
      onProgress: (transferred) => progress({ phase: 'downloading', version: pin.version, transferred, total: pin.size }),
    })
    if (result.size !== pin.size || result.sha256.toString('hex') !== pin.checksum) {
      throw new Error('存储桶里的程序包跟 Claude 清单里的校验值对不上')
    }
  }

  async function extract(archivePath: string, stagingDirectory: string, architecture: ClaudeDesktopVmArchitecture, signal: AbortSignal): Promise<ClaudeAppBundleExtraction> {
    if (typeof zlib.createZstdDecompress !== 'function') throw new Error('这个版本的运行时解不开 zstd')
    const result: { extraction?: ClaudeAppBundleExtraction } = {}
    await pipeline(
      fs.createReadStream(archivePath),
      zlib.createZstdDecompress(),
      async (input: AsyncIterable<Buffer>) => { result.extraction = await extractClaudeAppBundle(input, stagingDirectory) },
      { signal },
    )
    const binary = path.join(stagingDirectory, ...binaryRelativePath)
    const stats = await fs.promises.lstat(binary).catch(() => null)
    if (!stats?.isFile() || stats.size < binaryMinimumBytes || (stats.mode & 0o111) === 0) throw new Error('程序包里没有能执行的 Claude Code 程序')
    const header = await inspectMachOHeader(binary, architecture)
    if (header !== 'ok') throw new Error(header === 'arch-mismatch' ? '程序包里的程序不是这台 Mac 的架构' : '程序包里的程序不是 Mac 程序')
    if (!result.extraction) throw new Error('程序包没解开')
    return result.extraction
  }

  async function place(client: ClaudeDesktopSeedClient, pin: ClaudeCodeMacPin, seedPaths: ClaudeCodeMacSeedPaths, architecture: ClaudeDesktopVmArchitecture, signal: AbortSignal): Promise<'placed' | 'present'> {
    const label = 'Claude Code 程序'
    try {
      ensureSafeDataDirectory(seedPaths.versionDirectory, label)
    } catch (error) {
      throw new MacSeedSkip('write-failed', '建不了 Claude Desktop 放程序的文件夹', { cause: redact(errorMessage(error)) })
    }
    await removeStaleStaging(seedPaths.versionDirectory)
    const token = randomUUID()
    const archivePath = path.join(seedPaths.versionDirectory, `xingmang-${token}.tar.zst`)
    const stagingDirectory = path.join(seedPaths.versionDirectory, `xingmang-extract-${token}`)
    let stagingCreated = false
    try {
      try { await download(pin, archivePath, signal) }
      catch (error) {
        if (signal.aborted) throw new MacSeedSkip('timeout', '替 Claude Desktop 下程序超过了等待时长，先照常打开，下次打开再放')
        throw new MacSeedSkip('download-failed', '从下载站替 Claude Desktop 下程序没下成，照常打开', {
          cause: error instanceof DownloadStalledError ? '下载中途没有新数据' : errorMessage(error),
        })
      }
      progress({ phase: 'placing', version: pin.version, transferred: pin.size, total: pin.size })
      let extraction: ClaudeAppBundleExtraction
      try {
        assertNoReparseComponents(seedPaths.versionDirectory, label)
        // 跟 Claude 自己解包的临时目录一样只给自己：0700。
        await fs.promises.mkdir(stagingDirectory, { mode: 0o700 })
        stagingCreated = true
        extraction = await extract(archivePath, stagingDirectory, architecture, signal)
      } catch (error) {
        if (signal.aborted) throw new MacSeedSkip('timeout', '替 Claude Desktop 放程序超过了等待时长，先照常打开，下次打开再放')
        throw new MacSeedSkip('extract-failed', '程序包没解开，照常打开', { cause: redact(errorMessage(error)) })
      }
      await fs.promises.rm(archivePath, { force: true }).catch(() => undefined)
      // 下的这一阵客户可能自己从启动台开了 Claude：它开着就不动它的文件夹，下次打开再放。
      const running = client.isRunning ? await withTimeout(client.isRunning(), runningProbeTimeoutMs, null) : null
      if (running === true) throw new MacSeedSkip('started-meanwhile', 'Claude Desktop 在下载期间被打开了，这次不动它的文件夹')
      if (await inspectClaudeCodeMacSeed(seedPaths, pin.checksum, architecture) === 'present') return 'present'
      try {
        // 照 Claude 自己装的顺序：先撤掉「装完了」的记号，删掉没装完的那份，整个目录改名进去，最后写记号。
        if (await fs.promises.lstat(seedPaths.installDirectory).then(() => true, () => false)) {
          await removeSafeDataFile(seedPaths.verifiedPath, label)
          await removeSafeDirectory(seedPaths.installDirectory, label)
        }
        await renameWithTransientRetry(stagingDirectory, seedPaths.installDirectory, async () => {
          assertNoReparseComponents(seedPaths.versionDirectory, label)
          if (await fs.promises.lstat(seedPaths.installDirectory).then(() => true, () => false)) throw new Error(`${label}的目录在放进去前又出现了`)
        })
        stagingCreated = false
        if (assertSafeDataFile(seedPaths.verifiedPath, label)) throw new Error(`${label}的记号在写之前就有了`)
        await writeAtomicSafeUtf8File(seedPaths.verifiedPath, pin.checksum, label)
      } catch (error) {
        throw new MacSeedSkip('write-failed', '没能把程序放进 Claude Desktop 的文件夹', { cause: redact(errorMessage(error)) })
      }
      log('info', 'claude-desktop.mac-code-seed.placed', '已从下载站替 Claude Desktop 放好它要的 Claude Code 程序', {
        version: pin.version, build: pin.checksum.slice(0, buildIdLength), platform: pin.platform, archiveBytes: pin.size, bytes: extraction.bytes, files: extraction.files,
      })
      return 'placed'
    } finally {
      await fs.promises.rm(archivePath, { force: true }).catch(() => undefined)
      if (stagingCreated) await removeSafeDirectory(stagingDirectory, 'Claude Code 临时目录').catch(() => undefined)
    }
  }

  async function prepareNow(client: ClaudeDesktopSeedClient): Promise<ClaudeDesktopMacCodeSeedOutcome> {
    if (options.platform !== 'darwin') throw new MacSeedSkip('unsupported-platform', '只在 Mac 上从下载站替 Claude Desktop 放程序')
    if (options.isOff?.() === true) throw new MacSeedSkip('remote-off', '替 Claude Desktop 放程序已被远程关掉')
    if (client.running) throw new MacSeedSkip('running', 'Claude Desktop 开着，这次不动它的文件夹')
    let target: ClaudeDesktopComponentTarget | null
    try { target = await options.resolveTarget(client.path) }
    catch (error) {
      throw new MacSeedSkip('target-unresolved', '找不到 Claude Desktop 的数据目录', { cause: redact(errorMessage(error)) })
    }
    if (!target) throw new MacSeedSkip('target-unresolved', '找不到 Claude Desktop 的数据目录')
    const manifest = await manifestFor(target.asarPath)
    const pin = resolveClaudeCodeMacPin(manifest, target.architecture)
    if (!pin) throw new MacSeedSkip('pin-not-found', 'Claude Desktop 程序里没找到它要的 Claude Code 程序包，可能它换了放法', { asar: redact(target.asarPath), architecture: target.architecture })
    const seedPaths = claudeCodeMacSeedPaths(target.profileDirectory, pin)
    if (await inspectClaudeCodeMacSeed(seedPaths, pin.checksum, target.architecture) === 'present') {
      const key = `${pin.version}:${pin.checksum}`
      if (!reportedPresent.has(key)) {
        reportedPresent.add(key)
        log('info', 'claude-desktop.mac-code-seed.present', 'Claude Desktop 要的 Claude Code 程序已经在了', { version: pin.version, build: pin.checksum.slice(0, buildIdLength) })
      }
      return { status: 'present', version: pin.version }
    }
    const needed = pin.size * (1 + extractedSizeFallbackRatio) + installMinimumFreeBytes
    const space = await diskSpace(target.profileDirectory).catch(() => null)
    // 读不到空间照样放行（disk-space.ts 的 fail-open）；读得到就要够放压缩包加解开的那份。
    if (space && space.availableBytes < needed) {
      throw new MacSeedSkip('disk-space', '盘上空间不够，这次不替 Claude Desktop 放程序', { availableBytes: space.availableBytes, neededBytes: needed })
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
    timer.unref?.()
    const startedAt = now()
    try {
      const placed = await place(client, pin, seedPaths, target.architecture, controller.signal)
      if (placed === 'placed') log('info', 'claude-desktop.mac-code-seed.timing', '替 Claude Desktop 放程序用时', { ms: now() - startedAt })
      return { status: placed, version: pin.version }
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    prepare(client) {
      if (inFlight) return inFlight
      const pending = prepareNow(client).catch((error: unknown): ClaudeDesktopMacCodeSeedOutcome => {
        if (error instanceof MacSeedSkip) {
          // 这几样是「本来就不该做」，不是出了岔子。
          const quiet = error.reason === 'unsupported-platform' || error.reason === 'running' || error.reason === 'remote-off'
          log(quiet ? 'info' : 'warn', 'claude-desktop.mac-code-seed.skipped', error.message, { reason: error.reason, ...error.detail })
          return { status: 'skipped', reason: error.reason }
        }
        log('warn', 'claude-desktop.mac-code-seed.skipped', '替 Claude Desktop 放程序没成，照常打开', { reason: 'write-failed', cause: redact(errorMessage(error)) })
        return { status: 'skipped', reason: 'write-failed' }
      })
      inFlight = pending
      void pending.finally(() => { if (inFlight === pending) inFlight = null })
      return pending
    },
  }
}

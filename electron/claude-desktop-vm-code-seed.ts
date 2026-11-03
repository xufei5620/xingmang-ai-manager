/**
 * Cowork 的虚拟机里也要一份 Claude Code（Linux 版），Claude Desktop 照样从 downloads.claude.ai 下，国内下不动，
 * 工作区放好了也会卡在这一步。拆 4.4212.0 看到（claude-desktop-component-manifest.ts 读清单）：
 * - 要哪一版、官网压缩包 `claude.zst` 的 sha256 跟 Windows、Mac 那份写在同一段清单里（`linux-x64` / `linux-arm64`），
 *   架构跟着这台电脑走（x64 电脑用 linux-x64，Apple 芯片的 Mac 用 linux-arm64）。
 * - 放在 `<userData>/claude-code-vm/<版本>/<checksum 前 12 位>/claude`，格式跟 Windows 那份一样：程序、`.payload`
 *   （解开后的 sha256 和大小）、`.verified`（最后写）。启动时只看程序在、`.verified` 对得上，不重算整个文件
 *   （只有 Mac 本机那份多核 Mach-O 头）。
 * - npm 上 `@anthropic-ai/claude-code-linux-x64` 那一版的 `package/claude` 跟官网压缩包解开的逐字节相同（2.1.309
 *   比过，探测 41624912418）；linux-arm64 没比过，按同一个发布流程推测相同。
 *
 * 所以跟 Windows 那一半（claude-desktop-code-seed.ts）一样：从国内 npm 镜像下同一版的包，照旧拿 npm 官方源的
 * SHA-512 对账（不放宽），照它的格式放好。不占星芒存储桶的流量。只在放工作区那一步里跑（claude-desktop-
 * workspace-seed.ts：客户用了 Cowork、`.cowork-adopted` 在了才跑），远程开关跟工作区共用。
 */
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import zlib from 'node:zlib'
import { readBoundedResponseText } from './bounded-response'
import {
  claudeCodeTarballUrl, extractTarEntry, parseClaudeCodeNpmRelease, validateClaudeCodeTarballUrl,
  type ClaudeCodeNpmRelease, type TarEntryResult,
} from './claude-desktop-code-seed'
import type { ClaudeCodeComponentPins, ClaudeCodeLinuxPin, ClaudeCodeLinuxPlatform, ClaudeDesktopVmArchitecture } from './claude-desktop-component-manifest'
import { installMinimumFreeBytes, readDiskSpace, type DiskSpaceReading } from './disk-space'
import { downloadWithResume, DownloadStalledError } from './download-retry'
import { npmMirrorRegistry, npmOfficialRegistry, npmPackageVersionUrl } from './npm-registry'
import { fetchLandingWithRedirectAllowlist } from './redirect-allowlist-fetch'
import {
  assertNoReparseComponents, assertSafeDataFile, ensureSafeDataDirectory, removeSafeDataFile, renameWithTransientRetry,
  writeAtomicSafeUtf8File,
} from './safe-local-data'
import { redactHomeDirectory } from './startup-log'

export type ClaudeDesktopVmCodeSkipReason =
  | 'pin-not-found'
  | 'disk-space'
  | 'metadata-failed'
  | 'download-failed'
  | 'write-failed'
  | 'timeout'

export type ClaudeDesktopVmCodeSeedOutcome =
  | { status: 'present'; version: string }
  | { status: 'placed'; version: string }
  | { status: 'skipped'; reason: ClaudeDesktopVmCodeSkipReason }

export interface ClaudeCodeVmPin extends ClaudeCodeLinuxPin {
  version: string
  platform: ClaudeCodeLinuxPlatform
}

export interface ClaudeCodeVmSeedPaths {
  installDirectory: string
  binaryPath: string
  payloadPath: string
  verifiedPath: string
}

export interface ClaudeDesktopVmCodeSeederOptions {
  /** 下载用的 fetch（system-service 传接好系统代理、跳转一跳一跳交回来的那个）。 */
  fetch: typeof fetch
  userHome: string
  platform: NodeJS.Platform
  /** 包从哪几个源下，先后照这个顺序；缺省国内镜像在前、官方源兜底。对账值永远只从官方源取。 */
  tarballRegistries?: readonly string[]
  readDiskSpace?(target: string): Promise<DiskSpaceReading | null>
  pathModule?: path.PlatformPath
  timeoutMs?: number
  log?(level: 'info' | 'warn', event: string, message: string, detail?: Record<string, unknown>): void
  now?(): number
  resumeDelaysMs?: readonly number[]
}

export interface ClaudeDesktopVmCodeSeeder {
  /** 永不抛错。 */
  seed(input: { profileDirectory: string; architecture: ClaudeDesktopVmArchitecture; pins: ClaudeCodeComponentPins | null }): Promise<ClaudeDesktopVmCodeSeedOutcome>
}

export const claudeDesktopVmCodeSeedTimeoutMs = 15 * 60_000

const versionPattern = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/
const checksumPattern = /^[0-9a-f]{64}$/
const buildIdLength = 12
const tarballLimitBytes = 768 * 1024 * 1024
const binaryLimitBytes = 1024 * 1024 * 1024
const binaryMinimumBytes = 1024 * 1024
const npmMetadataLimitBytes = 256 * 1024
const npmMetadataTimeoutMs = 20_000
const tarballRedirectLimit = 3
const markerLimitBytes = 4 * 1024
const temporaryNamePattern = /^claude\.xingmang-[0-9a-f-]{36}\.(?:tgz|tmp)$/
// ELF 头：64 位（EI_CLASS = 2）、小端（EI_DATA = 1），e_machine 在第 18 字节：x86-64 = 62，AArch64 = 183。
const elfMachine: Record<ClaudeCodeLinuxPlatform, number> = { 'linux-x64': 62, 'linux-arm64': 183 }

class VmSeedSkip extends Error {
  constructor(readonly reason: ClaudeDesktopVmCodeSkipReason, message: string, readonly detail?: Record<string, unknown>) {
    super(message)
    this.name = 'VmSeedSkip'
  }
}

/** 虚拟机里跑哪一份：跟着这台电脑的架构。版本号或校验值不像样就当没有。 */
export function resolveClaudeCodeVmPin(pins: ClaudeCodeComponentPins | null, architecture: ClaudeDesktopVmArchitecture): ClaudeCodeVmPin | null {
  if (!pins || !versionPattern.test(pins.version)) return null
  const platform: ClaudeCodeLinuxPlatform = architecture === 'x64' ? 'linux-x64' : 'linux-arm64'
  const pin = pins.linux[platform]
  if (!pin || !checksumPattern.test(pin.checksum)) return null
  return { version: pins.version, platform, binary: pin.binary, checksum: pin.checksum, size: pin.size }
}

export function claudeCodeVmNpmPackageName(platform: ClaudeCodeLinuxPlatform): string {
  return `@anthropic-ai/claude-code-${platform}`
}

export function claudeCodeVmSeedPaths(profileDirectory: string, pin: Pick<ClaudeCodeVmPin, 'version' | 'checksum'>, paths: path.PlatformPath = path): ClaudeCodeVmSeedPaths {
  if (!versionPattern.test(pin.version) || !checksumPattern.test(pin.checksum)) throw new Error('Claude Code 版本号或校验值格式无效')
  const installDirectory = paths.join(profileDirectory, 'claude-code-vm', pin.version, pin.checksum.slice(0, buildIdLength))
  return {
    installDirectory,
    binaryPath: paths.join(installDirectory, 'claude'),
    payloadPath: paths.join(installDirectory, '.payload'),
    verifiedPath: paths.join(installDirectory, '.verified'),
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

/** Claude 会认的那一份在不在：程序在、不是空的、`.verified` 对得上。 */
export async function inspectClaudeCodeVmSeed(seedPaths: ClaudeCodeVmSeedPaths, checksum: string): Promise<'present' | 'missing'> {
  if ((await readSmallFile(seedPaths.verifiedPath))?.trim() !== checksum) return 'missing'
  try {
    const stats = await fs.promises.lstat(seedPaths.binaryPath)
    return stats.isFile() && stats.size > 0 ? 'present' : 'missing'
  } catch {
    return 'missing'
  }
}

/** 是不是这个架构的 64 位 Linux 程序。 */
export function isLinuxExecutableHeader(header: Buffer, platform: ClaudeCodeLinuxPlatform): boolean {
  return header.length >= 20
    && header[0] === 0x7f && header.subarray(1, 4).toString('latin1') === 'ELF'
    && header[4] === 2 && header[5] === 1
    && header.readUInt16LE(18) === elfMachine[platform]
}

function sha512Tap(hash: ReturnType<typeof createHash>): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk)
      callback(null, chunk)
    },
  })
}

/**
 * 一遍读完下好的包：边算整个包的 SHA-512，边解压取出 package/claude 写进临时文件、算它的 sha256。SHA-512 对不上
 * 官方源的当场作废（调用方删掉临时文件）。
 */
export async function verifyAndExtractClaudeCodeVmTarball(
  tarballPath: string,
  destination: string,
  release: ClaudeCodeNpmRelease,
  platform: ClaudeCodeLinuxPlatform,
  signal?: AbortSignal,
): Promise<{ sha256: string; size: number }> {
  const tarballHash = createHash('sha512')
  const binaryHash = createHash('sha256')
  const limit = release.unpackedSize ?? binaryLimitBytes
  // Claude 自己装完也是 chmod 755。
  const output = await fs.promises.open(destination, 'wx', 0o755)
  let result: TarEntryResult = { found: false, size: 0 }
  let written = 0
  try {
    await pipeline(
      fs.createReadStream(tarballPath, { highWaterMark: 1024 * 1024 }),
      sha512Tap(tarballHash),
      zlib.createGunzip(),
      async (source: AsyncIterable<Buffer>) => {
        result = await extractTarEntry(source, 'package/claude', async (chunk) => {
          binaryHash.update(chunk)
          let offset = 0
          while (offset < chunk.length) {
            const { bytesWritten } = await output.write(chunk, offset, chunk.length - offset, written + offset)
            if (bytesWritten <= 0) throw new Error('Claude Code 程序写入磁盘失败')
            offset += bytesWritten
          }
          written += chunk.length
        }, limit)
      },
      { signal },
    )
    await output.chmod(0o755)
    await output.sync()
  } finally {
    await output.close().catch(() => undefined)
  }
  if (!tarballHash.digest().equals(release.sha512)) throw new Error('下载的 Claude Code 程序包与 npm 官方源的 SHA-512 不一致')
  if (!result.found) throw new Error('程序包里没有 claude')
  if (result.size < binaryMinimumBytes) throw new Error('程序包里的 claude 太小')
  const head = Buffer.alloc(20)
  const check = await fs.promises.open(destination, 'r')
  try { await check.read(head, 0, 20, 0) }
  finally { await check.close().catch(() => undefined) }
  if (!isLinuxExecutableHeader(head, platform)) throw new Error('程序包里的 claude 不是这个架构的 Linux 程序')
  return { sha256: binaryHash.digest('hex'), size: result.size }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createClaudeDesktopVmCodeSeeder(options: ClaudeDesktopVmCodeSeederOptions): ClaudeDesktopVmCodeSeeder {
  const paths = options.pathModule ?? path
  const registries = options.tarballRegistries ?? [npmMirrorRegistry, npmOfficialRegistry]
  const timeoutMs = options.timeoutMs ?? claudeDesktopVmCodeSeedTimeoutMs
  const now = options.now ?? Date.now
  const diskSpace = options.readDiskSpace ?? ((target: string) => readDiskSpace(target))
  const reportedPresent = new Set<string>()
  let inFlight: Promise<ClaudeDesktopVmCodeSeedOutcome> | null = null

  function log(level: 'info' | 'warn', event: string, message: string, detail?: Record<string, unknown>): void {
    try { options.log?.(level, event, message, detail) }
    catch { /* 记日志失败不影响放程序。 */ }
  }

  function redact(value: string): string {
    return redactHomeDirectory(value, options.userHome, options.platform)
  }

  async function fetchRelease(packageName: string, version: string, signal: AbortSignal): Promise<ClaudeCodeNpmRelease> {
    const url = npmPackageVersionUrl(npmOfficialRegistry, packageName, version)
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(npmMetadataTimeoutMs)])
    let body: string
    try {
      const landing = await fetchLandingWithRedirectAllowlist(url, { headers: { Accept: 'application/json' }, credentials: 'omit', signal: requestSignal }, options.fetch, {
        label: 'npm 官方源包元数据',
        validate: (candidate) => {
          const parsed = new URL(candidate)
          if (parsed.href !== new URL(url).href) throw new Error('npm 官方源包元数据不许跳转')
          return parsed
        },
        maximumRedirects: 0,
      })
      if (!landing.response.ok) {
        await landing.response.body?.cancel().catch(() => undefined)
        throw new Error(`npm 官方源 HTTP ${landing.response.status}`)
      }
      body = await readBoundedResponseText(landing.response, npmMetadataLimitBytes, 'npm 官方源包元数据', { guard: { signal: requestSignal } })
    } catch (error) {
      if (signal.aborted) throw error
      throw new VmSeedSkip('metadata-failed', '拿不到 npm 官方源的对账值，这次不替 Cowork 放程序', { cause: errorMessage(error) })
    }
    const release = parseClaudeCodeNpmRelease(body, packageName, version)
    if (!release) throw new VmSeedSkip('metadata-failed', 'npm 官方源返回的包名、版本或 SHA-512 无效', { package: packageName, version })
    return release
  }

  async function downloadFrom(registry: string, packageName: string, version: string, tarballPath: string, signal: AbortSignal): Promise<void> {
    let current = claudeCodeTarballUrl(registry, packageName, version)
    let first = true
    const download = await downloadWithResume({
      targetPath: tarballPath,
      fileMode: 0o600,
      maximumBytes: tarballLimitBytes,
      oversizeMessage: 'Claude Code 程序包超过安全上限',
      signal,
      responseTimeoutMs: 30_000,
      idleTimeoutMs: 45_000,
      ...(options.resumeDelaysMs ? { resumeDelaysMs: options.resumeDelaysMs } : {}),
      request: async (headers, requestSignal) => {
        const landing = await fetchLandingWithRedirectAllowlist(current, {
          headers: { Accept: 'application/octet-stream, */*', ...headers },
          credentials: 'omit',
          signal: requestSignal,
        }, options.fetch, {
          label: 'Claude Code 程序下载',
          validate: (candidate) => validateClaudeCodeTarballUrl(candidate, packageName, version),
          // 接着下时只找上一次落到的那个文件，不再跟跳转（同 claude-desktop-code-seed.ts）。
          maximumRedirects: first ? tarballRedirectLimit : 0,
          beyondLimit: first ? 'refuse' : 'return',
        })
        first = false
        current = landing.url.href
        return landing.response
      },
      acceptResponse: (response) => {
        if (response.status !== 200) throw new Error(`HTTP ${response.status}`)
        const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
        if (/^text\/|json|xml|html/.test(contentType)) throw new Error(`返回的不是程序包（Content-Type: ${contentType}）`)
        const declared = response.headers.get('content-length')
        if (declared === null) return null
        const total = Number(declared)
        if (!Number.isSafeInteger(total) || total <= 0) throw new Error('返回的程序包大小无效')
        return total
      },
    })
    if (download.total !== null && download.size !== download.total) throw new Error('程序包没下完')
  }

  async function place(pin: ClaudeCodeVmPin, seedPaths: ClaudeCodeVmSeedPaths, release: ClaudeCodeNpmRelease, signal: AbortSignal): Promise<'placed' | 'present'> {
    const label = 'Cowork 的 Claude Code 程序'
    try {
      ensureSafeDataDirectory(seedPaths.installDirectory, label)
    } catch (error) {
      throw new VmSeedSkip('write-failed', '建不了 Cowork 放程序的文件夹', { cause: redact(errorMessage(error)) })
    }
    let names: string[] = []
    try { names = await fs.promises.readdir(seedPaths.installDirectory) }
    catch { /* 读不了就不清，下面照样只用新名字。 */ }
    for (const name of names.filter((entry) => temporaryNamePattern.test(entry)).slice(0, 16)) {
      await removeSafeDataFile(paths.join(seedPaths.installDirectory, name), 'Claude Code 临时文件').catch(() => undefined)
    }
    const token = randomUUID()
    const tarballPath = paths.join(seedPaths.installDirectory, `claude.xingmang-${token}.tgz`)
    const binaryTemporary = paths.join(seedPaths.installDirectory, `claude.xingmang-${token}.tmp`)
    const packageName = claudeCodeVmNpmPackageName(pin.platform)
    try {
      let extracted: { sha256: string; size: number } | null = null
      let source: string | null = null
      const failures: string[] = []
      for (const registry of registries) {
        if (signal.aborted) break
        try {
          await downloadFrom(registry, packageName, pin.version, tarballPath, signal)
          extracted = await verifyAndExtractClaudeCodeVmTarball(tarballPath, binaryTemporary, release, pin.platform, signal)
          source = registry
          break
        } catch (error) {
          failures.push(`${registry === npmMirrorRegistry ? '国内 npm 镜像' : 'npm 官方源'}：${error instanceof DownloadStalledError ? '下载中途没有新数据' : errorMessage(error)}`)
          await fs.promises.rm(binaryTemporary, { force: true }).catch(() => undefined)
        } finally {
          await fs.promises.rm(tarballPath, { force: true }).catch(() => undefined)
        }
      }
      if (signal.aborted) throw new VmSeedSkip('timeout', '替 Cowork 放程序超过了等待时长，下次再放', { failures })
      if (!extracted || !source) throw new VmSeedSkip('download-failed', '替 Cowork 下程序没下成', { failures })
      // 官网给的就是程序本身时，它的 sha256 就是 checksum，顺手对一下。
      if (pin.binary === 'claude' && extracted.sha256 !== pin.checksum) {
        throw new VmSeedSkip('download-failed', 'npm 上的程序和 Claude Desktop 要的那份不是同一个文件', { version: pin.version })
      }
      // 下的这几分钟里 Claude 可能自己装好了：好了就不换它的。
      if (await inspectClaudeCodeVmSeed(seedPaths, pin.checksum) === 'present') return 'present'
      try {
        // 照 Claude 自己装的顺序：先撤掉「装完了」的记号，再换程序，最后写记号。
        await removeSafeDataFile(seedPaths.verifiedPath, label)
        await removeSafeDataFile(seedPaths.payloadPath, label)
        await renameWithTransientRetry(binaryTemporary, seedPaths.binaryPath, () => {
          assertNoReparseComponents(seedPaths.installDirectory, label)
          assertSafeDataFile(seedPaths.binaryPath, label)
        })
        await writeAtomicSafeUtf8File(seedPaths.payloadPath, `${JSON.stringify({ sha256: extracted.sha256, size: extracted.size })}\n`, label)
        await writeAtomicSafeUtf8File(seedPaths.verifiedPath, pin.checksum, label)
      } catch (error) {
        throw new VmSeedSkip('write-failed', '没能把程序放进 Cowork 的文件夹', { cause: redact(errorMessage(error)) })
      }
      log('info', 'claude-desktop.vm-code-seed.placed', '已替 Cowork 放好它虚拟机里要的 Claude Code 程序', {
        version: pin.version, build: pin.checksum.slice(0, buildIdLength), platform: pin.platform, bytes: extracted.size,
        source: source === npmMirrorRegistry ? 'npm-mirror' : 'npm-official',
      })
      return 'placed'
    } finally {
      await fs.promises.rm(tarballPath, { force: true }).catch(() => undefined)
      await fs.promises.rm(binaryTemporary, { force: true }).catch(() => undefined)
    }
  }

  async function seedNow(input: { profileDirectory: string; architecture: ClaudeDesktopVmArchitecture; pins: ClaudeCodeComponentPins | null }): Promise<ClaudeDesktopVmCodeSeedOutcome> {
    const pin = resolveClaudeCodeVmPin(input.pins, input.architecture)
    if (!pin) throw new VmSeedSkip('pin-not-found', 'Claude Desktop 程序里没找到 Cowork 要的 Claude Code 版本，可能它换了放法', { architecture: input.architecture })
    const seedPaths = claudeCodeVmSeedPaths(input.profileDirectory, pin, paths)
    if (await inspectClaudeCodeVmSeed(seedPaths, pin.checksum) === 'present') {
      const key = `${pin.version}:${pin.checksum}`
      if (!reportedPresent.has(key)) {
        reportedPresent.add(key)
        log('info', 'claude-desktop.vm-code-seed.present', 'Cowork 要的 Claude Code 程序已经在了', { version: pin.version, build: pin.checksum.slice(0, buildIdLength) })
      }
      return { status: 'present', version: pin.version }
    }
    const space = await diskSpace(input.profileDirectory).catch(() => null)
    // 读不到空间照样放行（disk-space.ts 的 fail-open）。同 Windows 那一半，一道 1 GB 门槛。
    if (space && space.availableBytes < installMinimumFreeBytes) {
      throw new VmSeedSkip('disk-space', '盘上空间不够，这次不替 Cowork 放程序', { availableBytes: space.availableBytes })
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
    timer.unref?.()
    const startedAt = now()
    try {
      const release = await fetchRelease(claudeCodeVmNpmPackageName(pin.platform), pin.version, controller.signal)
      const placed = await place(pin, seedPaths, release, controller.signal)
      if (placed === 'placed') log('info', 'claude-desktop.vm-code-seed.timing', '替 Cowork 放程序用时', { ms: now() - startedAt })
      return { status: placed, version: pin.version }
    } catch (error) {
      if (controller.signal.aborted && !(error instanceof VmSeedSkip && error.reason === 'timeout')) {
        throw new VmSeedSkip('timeout', '替 Cowork 放程序超过了等待时长，下次再放', { cause: errorMessage(error) })
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    seed(input) {
      if (inFlight) return inFlight
      const pending = seedNow(input).catch((error: unknown): ClaudeDesktopVmCodeSeedOutcome => {
        if (error instanceof VmSeedSkip) {
          log('warn', 'claude-desktop.vm-code-seed.skipped', error.message, { reason: error.reason, ...error.detail })
          return { status: 'skipped', reason: error.reason }
        }
        log('warn', 'claude-desktop.vm-code-seed.skipped', '替 Cowork 放程序没成', { reason: 'write-failed', cause: redact(errorMessage(error)) })
        return { status: 'skipped', reason: 'write-failed' }
      })
      inFlight = pending
      void pending.finally(() => { if (inFlight === pending) inFlight = null })
      return pending
    },
  }
}

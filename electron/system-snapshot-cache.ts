import path from 'node:path'
import { providerIds, type ProviderId } from './catalog'
import { redactCommandText } from './command-runner'
import { ensureSafeDataDirectory, readSafeUtf8File, writeAtomicSafeUtf8File } from './safe-local-data'
import type { CliStatus, DesktopAppStatus, NetworkLocationStatus, NetworkRegion, SystemSnapshot, ToolStatus } from './system-service'
import type { CliUninstallCapability } from './tool-installation'

/**
 * 上一次首页扫描的结果留在本机，下次启动先拿它把首页画出来，后台照常重扫。低配
 * 机器上一轮扫描要起十来个探测子进程，首页以前要空着等它们全部回来。
 *
 * 这份文件只用来「先画个样子」：界面拿到它时仍当作正在检测（按钮不可点、不报
 * 「配置被改过」），真的扫描结果一回来就整份替换。主进程里任何要回答「装没装」
 * 的地方（Key 同步、开机检查、安装前检查）都不读它。
 */
export const SYSTEM_SNAPSHOT_CACHE_VERSION = 1

export type SystemSnapshotCacheWarningCode = 'snapshot-cache-read-failed' | 'snapshot-cache-write-failed'

export interface SystemSnapshotCacheOptions {
  filePath: string
  /**
   * 落盘时记下是哪一版软件写的。别的版本写的文件照样认（更新完第一次打开最想看到
   * 自己的工具），只是不带那一版的版本判断，见 withoutVersionVerdicts。
   */
  appVersion: string
  onWarning?: (code: SystemSnapshotCacheWarningCode, message: string) => void
  now?: () => Date
}

export interface SystemSnapshotCache {
  /** 读一次就记住；文件不存在、坏了、格式版本对不上都是 null。永不 reject。 */
  load(): Promise<SystemSnapshot | null>
  /** 按顺序落盘，后一次覆盖前一次；失败只报警告。永不 reject。 */
  save(snapshot: SystemSnapshot): Promise<void>
}

const fileLabel = '上次检测结果'
const maximumBytes = 512 * 1024
const maximumStringLength = 4096

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === 'string'
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean'
}

function isToolStatus(value: unknown): boolean {
  if (!isRecord(value)) return false
  return typeof value.installed === 'boolean'
    && nullableString(value.version)
    && nullableString(value.path)
    && nullableString(value.installDirectory)
    && optionalBoolean(value.detectionFailed)
    && (value.detectionError === undefined || nullableString(value.detectionError))
    && (value.uninstall === undefined || isRecord(value.uninstall))
}

function isCliStatus(value: unknown): boolean {
  return isToolStatus(value) && isRecord(value)
    && nullableString(value.latestVersion)
    && typeof value.updateAvailable === 'boolean'
    && isRecord(value.uninstall)
    && (value.versionAdvice === undefined || isRecord(value.versionAdvice))
}

function isDesktopStatus(value: unknown): boolean {
  return isToolStatus(value) && isRecord(value)
    && nullableString(value.appVersion)
    && nullableString(value.mirrorVersion)
    && nullableString(value.mirrorError)
    && typeof value.running === 'boolean'
}

function isNetworkStatus(value: unknown): boolean {
  return isRecord(value)
    && nullableString(value.countryCode)
    && typeof value.region === 'string'
    && typeof value.checkedAt === 'string'
    && nullableString(value.error)
}

/**
 * 界面拿到快照后会直接读 runtime / clis / desktopApps / network 下面的这些字段，
 * 缺一个就是白屏。其余可选字段保持原样：界面本来就当它们可能没有。别的版本写的
 * 文件也只过这一道，所以结构一变就要把格式版本号加一，见下面的 SnapshotShapePins。
 */
export function isCachedSystemSnapshot(value: unknown): value is SystemSnapshot {
  if (!isRecord(value) || typeof value.checkedAt !== 'string') return false
  const runtime = value.runtime
  const clis = value.clis
  const desktopApps = value.desktopApps
  if (!isRecord(runtime) || !isRecord(clis) || !isRecord(desktopApps)) return false
  return ['node', 'npm', 'python', 'git'].every((id) => isToolStatus(runtime[id]))
    && providerIds.every((id) => isCliStatus(clis[id]))
    && isDesktopStatus(desktopApps.codex)
    && isNetworkStatus(value.network)
}

/** T 里不带 `?` 的那些字段，连同它们的类型。 */
export type RequiredFields<T> = { [K in keyof T as {} extends Pick<T, K> ? never : K]: T[K] }

/** 两边互相赋得过去才算同一个形状：多一个、少一个、换了类型都不行。 */
export type SameShape<Actual, Pinned> = [Actual] extends [Pinned] ? [Pinned] extends [Actual] ? true : false : false

type Pin<Matches extends true> = Matches

/**
 * 别的版本写的文件也认，前提是快照结构没变：0.2.10 起每一版都只增减过可选字段。
 * 下面几个 Pinned 开头的接口把快照每一层的必填字段连同类型照抄了一份，有人加、删、
 * 改了其中一个（必填改可选、可选改必填也算），这里就过不了类型检查。改那份清单的
 * 同时把 SYSTEM_SNAPSHOT_CACHE_VERSION 加一，不然新版本会把上一版写的、缺了新字段的
 * 文件当成完整的结果交给首页。字段没变、意思变了（同一个布尔值换了判定方法）也要
 * 加一。可选字段的增减不用管，界面本来就当它可能没有。versionAdvice、revertVersion
 * 不在清单里：别的版本写的文件里，这两项整个不要（见 withoutVersionVerdicts）。
 */
type SnapshotShapePins = [
  Pin<SameShape<RequiredFields<SystemSnapshot>, PinnedSystemSnapshot>>,
  Pin<SameShape<RequiredFields<ToolStatus>, PinnedToolStatus>>,
  Pin<SameShape<RequiredFields<CliStatus>, PinnedCliStatus>>,
  Pin<SameShape<RequiredFields<DesktopAppStatus>, PinnedDesktopAppStatus>>,
  Pin<SameShape<RequiredFields<NetworkLocationStatus>, PinnedNetworkLocationStatus>>,
  Pin<SameShape<RequiredFields<CliUninstallCapability>, PinnedUninstallCapability>>,
]

interface PinnedSystemSnapshot {
  checkedAt: string
  network: NetworkLocationStatus
  runtime: Record<'node' | 'npm' | 'python' | 'git', ToolStatus>
  clis: Record<ProviderId, CliStatus>
  desktopApps: { codex: DesktopAppStatus }
}

interface PinnedToolStatus {
  installed: boolean
  version: string | null
  path: string | null
  installDirectory: string | null
}

interface PinnedCliStatus extends PinnedToolStatus {
  latestVersion: string | null
  updateAvailable: boolean
  uninstall: CliUninstallCapability
}

interface PinnedDesktopAppStatus extends PinnedToolStatus {
  appVersion: string | null
  mirrorVersion: string | null
  mirrorUpdateAvailable: boolean | null
  mirrorError: string | null
  running: boolean
}

interface PinnedNetworkLocationStatus {
  publicIp: string | null
  countryCode: string | null
  region: NetworkRegion
  checkedAt: string
  error: string | null
}

interface PinnedUninstallCapability {
  available: boolean
  reason: string | null
  manualCommand: string | null
}

function scrubStrings(value: unknown): unknown {
  if (typeof value === 'string') return redactCommandText(value).slice(0, maximumStringLength)
  if (Array.isArray(value)) return value.map(scrubStrings)
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, scrubStrings(entry)]))
  return value
}

/**
 * 落盘前去掉不该留在本机文件里的东西。快照本身不含任何 Key（Key 在配置那一块，
 * 那一块每次都现读）；但探测失败的报错里可能夹着命令输出，统一过一遍脱敏。
 * 官方 ChatGPT 账号的邮箱与额度、本机公网 IP 与「先画个样子」无关，不留。
 */
export function buildCachedSystemSnapshot(snapshot: SystemSnapshot): SystemSnapshot {
  const { officialChatGpt: _officialChatGpt, cachedAt: _cachedAt, ...rest } = snapshot
  const scrubbed = scrubStrings({ ...rest, network: { ...rest.network, publicIp: null } })
  return scrubbed as SystemSnapshot
}

export function serializeSystemSnapshotCache(snapshot: SystemSnapshot, appVersion: string, savedAt: Date): string | null {
  const content = `${JSON.stringify({
    version: SYSTEM_SNAPSHOT_CACHE_VERSION,
    appVersion,
    savedAt: savedAt.toISOString(),
    snapshot: buildCachedSystemSnapshot(snapshot),
  })}\n`
  return Buffer.byteLength(content, 'utf8') > maximumBytes ? null : content
}

/**
 * 别的版本写的结果里，有几项是那一版按它自带的推荐版本名单下的判断：推荐装哪一版
 * （versionAdvice）、能退回哪一版（revertVersion）、算不算有更新（updateAvailable、
 * updateState）。新版本的名单可能已经换了推荐版本，而首页先摆上次结果的这几秒里
 * 「更新」「更新到推荐版本」是能点的：点下去版本号原样交给主进程，主进程见到点名的
 * 版本就直接装（resolveCliInstallVersion）。所以跨版本只留装没装、装在哪、什么版本
 * 这些事实，这类按钮等这次检测回来再出。
 */
function withoutVersionVerdicts(snapshot: SystemSnapshot): SystemSnapshot {
  const clis = Object.fromEntries(providerIds.map((id) => {
    const { versionAdvice: _versionAdvice, revertVersion: _revertVersion, ...facts } = snapshot.clis[id]
    const status: CliStatus = { ...facts, updateAvailable: false, updateState: 'unknown' }
    return [id, status]
  })) as Record<ProviderId, CliStatus>
  return { ...snapshot, clis }
}

/**
 * 读出来的快照带上 `cachedAt`（落盘时间），界面据此知道这是上次的结果。别的版本
 * 写的也认，只是去掉那一版的版本判断（见 withoutVersionVerdicts）。
 */
export function parseSystemSnapshotCache(content: string, appVersion: string): SystemSnapshot | null {
  let document: unknown
  try {
    document = JSON.parse(content) as unknown
  } catch {
    return null
  }
  if (!isRecord(document) || document.version !== SYSTEM_SNAPSHOT_CACHE_VERSION) return null
  const savedAt = typeof document.savedAt === 'string' ? Date.parse(document.savedAt) : Number.NaN
  if (!Number.isFinite(savedAt)) return null
  if (!isCachedSystemSnapshot(document.snapshot)) return null
  const { officialChatGpt: _officialChatGpt, ...saved } = document.snapshot
  const snapshot = document.appVersion === appVersion ? saved : withoutVersionVerdicts(saved)
  return { ...snapshot, cachedAt: new Date(savedAt).toISOString() }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createSystemSnapshotCache(options: SystemSnapshotCacheOptions): SystemSnapshotCache {
  const filePath = path.resolve(options.filePath)
  const warn = options.onWarning ?? (() => undefined)
  const now = options.now ?? (() => new Date())
  let loading: Promise<SystemSnapshot | null> | null = null
  let writing: Promise<void> = Promise.resolve()
  async function read(): Promise<SystemSnapshot | null> {
    try {
      const content = await readSafeUtf8File(filePath, fileLabel, maximumBytes)
      return content === null ? null : parseSystemSnapshotCache(content, options.appVersion)
    } catch (error) {
      warn('snapshot-cache-read-failed', errorText(error))
      return null
    }
  }
  async function write(snapshot: SystemSnapshot): Promise<void> {
    try {
      const content = serializeSystemSnapshotCache(snapshot, options.appVersion, now())
      if (content === null) return
      ensureSafeDataDirectory(path.dirname(filePath), fileLabel)
      await writeAtomicSafeUtf8File(filePath, content, fileLabel)
    } catch (error) {
      warn('snapshot-cache-write-failed', errorText(error))
    }
  }
  return {
    load() {
      if (!loading) loading = read()
      return loading
    },
    save(snapshot) {
      writing = writing.then(() => write(snapshot))
      return writing
    },
  }
}

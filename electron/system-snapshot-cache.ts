import path from 'node:path'
import { providerIds } from './catalog'
import { redactCommandText } from './command-runner'
import { ensureSafeDataDirectory, readSafeUtf8File, writeAtomicSafeUtf8File } from './safe-local-data'
import type { SystemSnapshot } from './system-service'

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
  /** 换了版本的软件不认旧文件：快照结构可能变了，重扫一次很便宜。 */
  appVersion: string
  onWarning?: (code: SystemSnapshotCacheWarningCode, message: string) => void
  now?: () => Date
}

export interface SystemSnapshotCache {
  /** 读一次就记住；文件不存在、坏了、版本对不上都是 null。永不 reject。 */
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
 * 缺一个就是白屏。其余可选字段保持原样，由同一版本的软件写入，结构一致。
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

/** 读出来的快照带上 `cachedAt`（落盘时间），界面据此知道这是上次的结果。 */
export function parseSystemSnapshotCache(content: string, appVersion: string): SystemSnapshot | null {
  let document: unknown
  try {
    document = JSON.parse(content) as unknown
  } catch {
    return null
  }
  if (!isRecord(document) || document.version !== SYSTEM_SNAPSHOT_CACHE_VERSION) return null
  if (document.appVersion !== appVersion) return null
  const savedAt = typeof document.savedAt === 'string' ? Date.parse(document.savedAt) : Number.NaN
  if (!Number.isFinite(savedAt)) return null
  if (!isCachedSystemSnapshot(document.snapshot)) return null
  const { officialChatGpt: _officialChatGpt, ...snapshot } = document.snapshot
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

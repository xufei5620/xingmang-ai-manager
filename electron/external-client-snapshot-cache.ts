import path from 'node:path'
import { redactCommandText } from './command-runner'
import { externalClientOfficialDownloadUrls, externalToolIds, isExternalToolId, type ExternalClientStatus } from './external-client-contract'
import type { ExternalToolId } from './external-tool-config'
import { ensureSafeDataDirectory, readSafeUtf8File, writeAtomicSafeUtf8File } from './safe-local-data'
import type { OptionalKeys, Pin, RequiredFields, SameShape } from './system-snapshot-cache'

/**
 * 上一次检测 WorkBuddy、Claude Desktop、OpenCode 的结果留在本机，下次启动先拿它把首页那几行
 * 画出来（已知13）。真的那轮（Windows 上是一整段 PowerShell）照旧排在首屏扫描之后才跑
 * （见 useToolbox），以前开机那三行要空着等十几到二十几秒。
 *
 * 同 system-snapshot-cache.ts，这份文件只用来「先画个样子」：界面拿到它（带 cachedAt）时当作
 * 还在检测，那几行的按钮一律等真的结果，真的结果一回来就整份替换。主进程里要回答「装没装」
 * 「配给谁了」的地方（安装、打开、配置、连接自检、反馈报告）都不读它。
 */
export const EXTERNAL_CLIENT_SNAPSHOT_CACHE_VERSION = 1

export type ExternalClientSnapshotCacheWarningCode = 'external-client-cache-read-failed' | 'external-client-cache-write-failed'

export interface ExternalClientSnapshotCacheOptions {
  filePath: string
  onWarning?: (code: ExternalClientSnapshotCacheWarningCode, message: string) => void
  now?: () => Date
}

export interface ExternalClientSnapshotCache {
  /** 读一次就记住；文件不存在、坏了、格式版本对不上都是 null。永不 reject。 */
  load(): Promise<ExternalClientStatus[] | null>
  /** 按顺序落盘，后一次覆盖前一次；不是三家各一条的整份就不写。失败只报警告，永不 reject。 */
  save(statuses: readonly ExternalClientStatus[]): Promise<void>
}

const fileLabel = '上次客户端检测结果'
const maximumBytes = 512 * 1024
const maximumStringLength = 4096
// 赋给更宽的类型再按客户端查，不用断言：没有下载页的那家查出来是 undefined。
const officialDownloadUrls: Partial<Record<ExternalToolId, string>> = externalClientOfficialDownloadUrls

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === 'string'
}

function isConfigurationSource(value: unknown): value is ExternalClientStatus['configurationSource'] {
  return value === 'xingmang' || value === 'other' || value === 'missing' || value === 'unknown'
}

/**
 * 首页拿到后直接读这些字段（presentExternalClients、首页的工具行），缺一个或换了类型就是白屏
 * 或说错话。别的版本写的文件也只过这一道，所以字段一变就要把格式版本号加一，见下面的
 * ExternalClientShapePins。下载页只认这家客户端白名单里的那一条（I12）：文件在用户自己能写的
 * 目录里，不能让它借首页塞一个网址进来。
 */
export function isCachedExternalClientStatus(value: unknown): value is ExternalClientStatus {
  if (!isRecord(value) || !isExternalToolId(value.tool)) return false
  const downloadUrl = value.officialDownloadUrl
  return typeof value.installed === 'boolean'
    && nullableString(value.version)
    && nullableString(value.path)
    && nullableString(value.installDirectory)
    && typeof value.running === 'boolean'
    && typeof value.installSupported === 'boolean'
    && typeof value.launchSupported === 'boolean'
    && nullableString(value.detectionError)
    && nullableString(value.installHint)
    && (downloadUrl === undefined || downloadUrl === null || downloadUrl === officialDownloadUrls[value.tool])
    && typeof value.configured === 'boolean'
    && (value.configurationReady === undefined || typeof value.configurationReady === 'boolean')
    && nullableString(value.model)
    && isConfigurationSource(value.configurationSource)
    && nullableString(value.configurationError)
}

/**
 * 别的版本写的文件也认（更新完第一次打开最想看到自己的客户端），前提是结构没变。下面照抄了
 * 一份必填字段连同类型、一份可选字段名：有人加、删、改了其中一个（必填改可选、可选改必填也算），
 * 这里就过不了类型检查。必填字段变了，改清单的同时把 EXTERNAL_CLIENT_SNAPSHOT_CACHE_VERSION
 * 加一，不然新版本会把上一版写的、缺了新字段的文件当成完整的结果交给首页；字段没变、意思变了
 * 也要加一。可选字段变了，先想清楚它该不该落盘，再改 cachedStatus 和这份清单。
 */
type ExternalClientShapePins = [
  Pin<SameShape<RequiredFields<ExternalClientStatus>, PinnedExternalClientStatus>>,
  Pin<SameShape<OptionalKeys<ExternalClientStatus>, ExternalClientOptionalFields>>,
]

interface PinnedExternalClientStatus {
  tool: ExternalToolId
  installed: boolean
  version: string | null
  path: string | null
  installDirectory: string | null
  running: boolean
  installSupported: boolean
  launchSupported: boolean
  detectionError: string | null
  installHint: string | null
  configured: boolean
  model: string | null
  configurationSource: 'xingmang' | 'other' | 'missing' | 'unknown'
  configurationError: string | null
}

type ExternalClientOptionalFields = 'officialDownloadUrl' | 'configurationReady' | 'cachedAt'

function scrub(value: string | null): string | null {
  return value === null ? null : redactCommandText(value).slice(0, maximumStringLength)
}

/**
 * 落盘和读回来都只过这一道，只留上面清单里的字段：读回来时文件里多出来的东西不往界面送。
 * 「运行中」不留：上次开着不代表这次还开着，真的结果回来再说。报错里可能夹着命令输出，
 * 统一过一遍脱敏（这几行本来就不含 Key，Key 只在主进程现读）。
 */
function cachedStatus(status: ExternalClientStatus): ExternalClientStatus {
  const downloadUrl = status.officialDownloadUrl === null || status.officialDownloadUrl === officialDownloadUrls[status.tool] ? status.officialDownloadUrl : undefined
  return {
    tool: status.tool,
    installed: status.installed,
    version: scrub(status.version),
    path: scrub(status.path),
    installDirectory: scrub(status.installDirectory),
    running: false,
    installSupported: status.installSupported,
    launchSupported: status.launchSupported,
    detectionError: scrub(status.detectionError),
    installHint: scrub(status.installHint),
    ...(downloadUrl === undefined ? {} : { officialDownloadUrl: downloadUrl }),
    configured: status.configured,
    ...(status.configurationReady === undefined ? {} : { configurationReady: status.configurationReady }),
    model: scrub(status.model),
    configurationSource: status.configurationSource,
    configurationError: scrub(status.configurationError),
  }
}

/** 三家各一条才算整份：装好一家以后那份只更新了一行的，不拿来当「上次的结果」。 */
function completeList(statuses: readonly ExternalClientStatus[]): boolean {
  return statuses.length === externalToolIds.length
    && externalToolIds.every((tool) => statuses.filter((status) => status.tool === tool).length === 1)
}

export function serializeExternalClientSnapshotCache(statuses: readonly ExternalClientStatus[], savedAt: Date): string | null {
  if (!completeList(statuses)) return null
  const content = `${JSON.stringify({
    version: EXTERNAL_CLIENT_SNAPSHOT_CACHE_VERSION,
    savedAt: savedAt.toISOString(),
    clients: statuses.map(cachedStatus),
  })}\n`
  return Buffer.byteLength(content, 'utf8') > maximumBytes ? null : content
}

/** 读出来的每一条都带上 `cachedAt`（落盘时间），界面据此知道这是上次的结果。 */
export function parseExternalClientSnapshotCache(content: string): ExternalClientStatus[] | null {
  let document: unknown
  try {
    document = JSON.parse(content) as unknown
  } catch {
    return null
  }
  if (!isRecord(document) || document.version !== EXTERNAL_CLIENT_SNAPSHOT_CACHE_VERSION) return null
  const savedAt = typeof document.savedAt === 'string' ? Date.parse(document.savedAt) : Number.NaN
  if (!Number.isFinite(savedAt) || !Array.isArray(document.clients)) return null
  const clients: unknown[] = document.clients
  if (!clients.every(isCachedExternalClientStatus) || !completeList(clients)) return null
  const cachedAt = new Date(savedAt).toISOString()
  return clients.map((status) => ({ ...cachedStatus(status), cachedAt }))
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createExternalClientSnapshotCache(options: ExternalClientSnapshotCacheOptions): ExternalClientSnapshotCache {
  const filePath = path.resolve(options.filePath)
  const warn = options.onWarning ?? (() => undefined)
  const now = options.now ?? (() => new Date())
  let loading: Promise<ExternalClientStatus[] | null> | null = null
  let writing: Promise<void> = Promise.resolve()
  async function read(): Promise<ExternalClientStatus[] | null> {
    try {
      const content = await readSafeUtf8File(filePath, fileLabel, maximumBytes)
      return content === null ? null : parseExternalClientSnapshotCache(content)
    } catch (error) {
      warn('external-client-cache-read-failed', errorText(error))
      return null
    }
  }
  async function write(statuses: readonly ExternalClientStatus[]): Promise<void> {
    try {
      const content = serializeExternalClientSnapshotCache(statuses, now())
      if (content === null) return
      ensureSafeDataDirectory(path.dirname(filePath), fileLabel)
      await writeAtomicSafeUtf8File(filePath, content, fileLabel)
    } catch (error) {
      warn('external-client-cache-write-failed', errorText(error))
    }
  }
  return {
    load() {
      if (!loading) loading = read()
      return loading
    },
    save(statuses) {
      writing = writing.then(() => write(statuses))
      return writing
    },
  }
}

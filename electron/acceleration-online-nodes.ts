// 在线换节点（2026-10-22 yoyo「做在线换节点」）：节点商迁址那次（#1352）安装包里的节点全断了，只能出新版本
// 才换得掉。现在更新目录里另放一份带发布者签名的节点文件（acceleration-nodes.json），客户端开机读一次、之后
// 每小时读一次，签名对、又比记下的新，就原样记在本机；加速时用记下的那份。没记过、记的那份读坏了、或者发布者
// 撤回了，就用安装包自带的节点。发布走 acceleration-nodes 工作流（scripts/acceleration-nodes.cjs），每次要
// yoyo 批准。
//
// Why a signature and not just HTTPS: the node file sits in the same R2 bucket as
// the installers, and whoever holds that bucket's upload credential could point
// every customer's ChatGPT traffic at a server of their choosing. The publisher's
// Ed25519 key (the one that signs latest.yml, see update-package-signature.ts)
// never touches the bucket. The signed text starts with its own header, so a
// signature made for an update entry never verifies as a node list or the other
// way round. scripts/acceleration-nodes.cjs builds the same text; the two are
// pinned together by acceleration-online-nodes.test.ts.
//
// The stored copy lives in user-writable app data. It is the exact text that was
// fetched, and every reader verifies the signature again instead of trusting
// whoever wrote the file. Rules, ports and everything else about the connection
// stay in the client (acceleration-clash-config.ts): a signed list can only
// change which servers the line connects to, through the same parser the
// bundled profile goes through.
import path from 'node:path'
import { createHash } from 'node:crypto'
import { parseClashAccelerationProfile, type AccelerationClashProfile } from './acceleration-clash-config'
import { readBoundedResponseText } from './bounded-response'
import { isRecord } from './input-guards'
import { ensureSafeDataDirectory, readSafeUtf8File, writeAtomicSafeUtf8File } from './safe-local-data'
import { verifyPublisherSignature } from './update-package-signature'

export const accelerationNodesFileName = 'acceleration-nodes.json'
const PAYLOAD_HEADER = 'xingmang-acceleration-nodes/v1'
// 一条线路一两百字节，解析上限 512 条也到不了；上限只防这个地址被换成别的大文件。
export const maxAccelerationNodesBytes = 256 * 1024
const defaultTimeoutMs = 10_000
const defaultIntervalMs = 60 * 60_000
const storeLabel = '在线加速节点'

export interface AccelerationNodesDocument {
  issuedAt: string
  /** null：发布者撤回了在线节点，用安装包自带的。 */
  profile: AccelerationClashProfile | null
}

/**
 * malformed：不是这种文件；unsigned：没签名；signature：签名不对；profile：签名对，但里面没有这一版
 * 客户端能用的线路（比如以后换了它不认的协议）；older：比记下的那份旧（被人换回了旧文件，或者缓存没刷新）。
 */
export type AccelerationNodesRejection = 'malformed' | 'unsigned' | 'signature' | 'profile' | 'older'

export type AccelerationNodesVerdict =
  | { ok: true, document: AccelerationNodesDocument }
  | { ok: false, reason: Exclude<AccelerationNodesRejection, 'older'> }

/** 主进程写、加速辅助进程读的是同一个位置，两边都从这里取。 */
export function accelerationOnlineNodesPath(dataDirectory: string): string {
  return path.join(dataDirectory, accelerationNodesFileName)
}

/** 节点文件跟更新清单、服务状态文件在同一个目录。 */
export function resolveAccelerationNodesUrl(serviceStatusUrl: string): string {
  return new URL(accelerationNodesFileName, serviceStatusUrl).href
}

export function buildAccelerationNodesPayload(issuedAt: string, profileSha256: string | null): string | null {
  if (typeof issuedAt !== 'string' || !issuedAt || /[\r\n\0]/.test(issuedAt)) return null
  if (profileSha256 !== null && (typeof profileSha256 !== 'string' || !/^[a-f\d]{64}$/.test(profileSha256))) return null
  return `${PAYLOAD_HEADER}\nissuedAt=${issuedAt}\nprofileSha256=${profileSha256 ?? 'none'}\n`
}

// 只认脚本写的那种 ISO 时间（toISOString）：同一时刻只有一种写法，签的字和比新旧用的是同一个值。
// 不拦「写在未来」的时间：只有发布者签得出来，脚本用的是 GitHub 的时钟；拦了，时钟慢一天以上的电脑
// 就永远用不上在线节点。
function readIssuedAt(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const at = Date.parse(value)
  return Number.isFinite(at) && new Date(at).toISOString() === value ? value : null
}

/** 校验一份节点文件。永不抛错：哪里不对都返回拒绝的原因。 */
export function parseSignedAccelerationNodes(
  text: string,
  options: { publicKeys?: readonly string[] } = {},
): AccelerationNodesVerdict {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > maxAccelerationNodesBytes) return { ok: false, reason: 'malformed' }
  let value: unknown
  try {
    value = JSON.parse(text.replace(/^﻿/, ''))
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (!isRecord(value) || value.format !== 1) return { ok: false, reason: 'malformed' }
  const issuedAt = readIssuedAt(value.issuedAt)
  const source = value.profile
  if (!issuedAt || (source !== null && (typeof source !== 'string' || !source))) return { ok: false, reason: 'malformed' }
  if (value.signature === undefined || value.signature === null || value.signature === '') return { ok: false, reason: 'unsigned' }
  const digest = source === null ? null : createHash('sha256').update(source, 'utf8').digest('hex')
  const payload = buildAccelerationNodesPayload(issuedAt, digest)
  if (payload === null || !verifyPublisherSignature(payload, value.signature, options.publicKeys)) {
    return { ok: false, reason: 'signature' }
  }
  if (source === null) return { ok: true, document: { issuedAt, profile: null } }
  try {
    return { ok: true, document: { issuedAt, profile: parseClashAccelerationProfile(source) } }
  } catch {
    return { ok: false, reason: 'profile' }
  }
}

export function isNewerAccelerationNodes(next: Pick<AccelerationNodesDocument, 'issuedAt'>, current: Pick<AccelerationNodesDocument, 'issuedAt'>): boolean {
  return Date.parse(next.issuedAt) > Date.parse(current.issuedAt)
}

/** 记在本机的那份。没有、读坏了、签名不对都返回 null，当没记过。 */
export async function readStoredAccelerationNodes(
  filePath: string,
  options: { publicKeys?: readonly string[] } = {},
): Promise<AccelerationNodesDocument | null> {
  try {
    const text = await readSafeUtf8File(filePath, storeLabel, maxAccelerationNodesBytes)
    if (text === null) return null
    const verdict = parseSignedAccelerationNodes(text, options)
    return verdict.ok ? verdict.document : null
  } catch {
    return null
  }
}

export interface AccelerationNodesFetchOptions {
  url: string
  fetch: (url: string, init: RequestInit) => Promise<Response>
  timeoutMs?: number
}

/**
 * 读一次节点文件，读不到（没联网、还没发布过、超时、被重定向、太大）返回 null。重定向直接拒绝，理由跟
 * 服务状态文件一样：它和更新清单在同一个目录，没有理由跳去别处。
 */
export async function fetchAccelerationNodes(options: AccelerationNodesFetchOptions): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? defaultTimeoutMs)
  timer.unref?.()
  try {
    const response = await options.fetch(options.url, {
      method: 'GET',
      redirect: 'error',
      cache: 'no-store',
      credentials: 'omit',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      return null
    }
    return await readBoundedResponseText(response, maxAccelerationNodesBytes, storeLabel, { guard: { signal: controller.signal } })
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export type AccelerationNodesRefresh = 'updated' | 'unchanged' | 'unavailable' | 'rejected' | 'failed'

export interface AccelerationNodesUpdaterOptions extends AccelerationNodesFetchOptions {
  filePath: string
  publicKeys?: readonly string[]
  /** 多久再读一次；默认一小时。节点难得换一回，读得比服务状态文件疏。 */
  intervalMs?: number
  onUpdated?(document: AccelerationNodesDocument): void
  onRejected?(reason: AccelerationNodesRejection): void
  onStoreFailed?(error: unknown): void
}

export interface AccelerationNodesUpdater {
  start(): void
  refresh(): Promise<AccelerationNodesRefresh>
  /** 记在本机的那份（开机时记一笔日志用）。 */
  stored(): Promise<AccelerationNodesDocument | null>
  dispose(): void
}

/** 开机读一次，之后定时再读。同一时间只有一个请求在路上；读到更新的才写盘。 */
export function createAccelerationNodesUpdater(options: AccelerationNodesUpdaterOptions): AccelerationNodesUpdater {
  if (!path.isAbsolute(options.filePath)) throw new Error('在线加速节点必须使用绝对路径。')
  const intervalMs = options.intervalMs ?? defaultIntervalMs
  const keys = options.publicKeys ? { publicKeys: options.publicKeys } : {}
  let inflight: Promise<AccelerationNodesRefresh> | null = null
  let timer: NodeJS.Timeout | null = null
  let started = false
  let disposed = false

  async function run(): Promise<AccelerationNodesRefresh> {
    const text = await fetchAccelerationNodes(options)
    if (text === null || disposed) return 'unavailable'
    const verdict = parseSignedAccelerationNodes(text, keys)
    if (!verdict.ok) {
      options.onRejected?.(verdict.reason)
      return 'rejected'
    }
    const stored = await readStoredAccelerationNodes(options.filePath, keys)
    if (stored && !isNewerAccelerationNodes(verdict.document, stored)) {
      if (isNewerAccelerationNodes(stored, verdict.document)) {
        options.onRejected?.('older')
        return 'rejected'
      }
      return 'unchanged'
    }
    if (disposed) return 'unavailable'
    try {
      ensureSafeDataDirectory(path.dirname(options.filePath), storeLabel)
      // 原样记下读到的那几个字节：辅助进程读的时候再验一遍同一份签名。
      await writeAtomicSafeUtf8File(options.filePath, text, storeLabel)
    } catch (error) {
      options.onStoreFailed?.(error)
      return 'failed'
    }
    options.onUpdated?.(verdict.document)
    return 'updated'
  }

  function refresh(): Promise<AccelerationNodesRefresh> {
    if (disposed) return Promise.resolve('unavailable')
    inflight ??= run().catch((): AccelerationNodesRefresh => 'unavailable').finally(() => { inflight = null })
    return inflight
  }

  return {
    start() {
      if (started || disposed) return
      started = true
      void refresh()
      timer = setInterval(() => { void refresh() }, intervalMs)
      timer.unref?.()
    },
    refresh,
    stored: () => readStoredAccelerationNodes(options.filePath, keys),
    dispose() {
      disposed = true
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}

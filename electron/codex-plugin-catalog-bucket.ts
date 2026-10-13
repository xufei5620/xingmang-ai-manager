import { createHash } from 'node:crypto'
import { readBoundedResponseText } from './bounded-response'
import {
  desktopPackageBucketOrigin,
  DesktopBucketUnavailableError,
  fetchDesktopBucketResource,
  isDesktopBucketDownloadTooSlow,
} from './desktop-package-bucket'

/**
 * 星芒存储桶里的 Codex 官方插件目录：scripts/sync-codex-plugins-cos.cjs 定时看 github.com/openai/plugins
 * 的 main，变了才把那个提交的压缩包核过传上来，清单里写着提交号、大小和 SHA-256。替 Codex 下第一份目录时
 * 先从这里下：国内快，也用不着加速（yoyo 2026-10-13「插件目录放存储桶」，为的是以后去掉游戏加速）。
 * 读不到、对不上、太慢都抛 DesktopBucketUnavailableError，调用方悄悄换回 GitHub 那一路。
 *
 * Trust: the bucket origin and the index key are constants, and every request goes through
 * fetchDesktopBucketResource, which pins the host and path and refuses redirects (I10). The
 * index only names an object key that must have exactly the layout the sync script writes.
 * Its size and SHA-256 bind the download; the caller then applies the same archive rules
 * it applies to GitHub's copy and requires the archive's own commit to match the index.
 */

const indexKey = 'xingmang/offline/codex-plugins/latest.json'
const objectPrefix = 'xingmang/offline/codex-plugins'
const maximumIndexBytes = 64 * 1024
const indexTimeoutMs = 10_000
// 同同步脚本：再小不是这份目录；上限同 codex-plugin-catalog.ts 收 GitHub 那一份的。
const minimumArchiveBytes = 64 * 1024
const maximumArchiveBytes = 150 * 1024 * 1024
const archiveContentTypes = new Set(['application/gzip', 'application/octet-stream'])
/**
 * 二十来 MB，国内连上海的桶几秒到一两分钟。照目前速度还要 2 分钟以上才下得完，或者半分钟没收到
 * 一个字节，就换 GitHub 那一路：在国外的客户连桶可能反而慢。
 */
export const codexCatalogBucketDownloadLimitMs = 2 * 60_000
const archiveIdleMs = 30_000
const archiveTotalMs = 4 * 60_000

export interface CodexPluginCatalogBucketRelease {
  commit: string
  url: string
  bytes: number
  /** Lower-case hex. */
  sha256: string
}

export interface CodexPluginCatalogBucketDownload {
  commit: string
  compressed: Buffer
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function objectUrl(key: string): string {
  return `${desktopPackageBucketOrigin}/${key}`
}

export function codexPluginCatalogBucketIndexUrl(): string {
  return objectUrl(indexKey)
}

/** 从桶里的清单原文挑出那份目录；格式、来源、地址、大小、摘要有一处不对就是 null。 */
export function parseCodexPluginCatalogBucketIndex(text: string): CodexPluginCatalogBucketRelease | null {
  if (!text.trim() || Buffer.byteLength(text, 'utf8') > maximumIndexBytes) return null
  let root: unknown
  try { root = JSON.parse(text) } catch { return null }
  if (!isRecord(root) || root.schemaVersion !== 1 || root.product !== 'codex-plugin-catalog'
    || !isRecord(root.source) || !isRecord(root.artifact)) return null
  const { source, artifact } = root
  const commit = source.commit
  if (source.repository !== 'openai/plugins' || source.ref !== 'main' || typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) return null
  const sha256 = artifact.sha256
  if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) return null
  const key = `${objectPrefix}/sha256-${sha256}/openai-plugins-${commit}.tar.gz`
  const bytes = artifact.bytes
  if (
    artifact.key !== key
    || artifact.url !== objectUrl(key)
    || artifact.contentType !== 'application/gzip'
    || artifact.verification !== 'github-commit-archive-manifests'
    || typeof bytes !== 'number'
    || !Number.isSafeInteger(bytes)
    || bytes < minimumArchiveBytes
    || bytes > maximumArchiveBytes
  ) return null
  return { commit, url: objectUrl(key), bytes, sha256 }
}

async function readRelease(fetchImplementation: typeof fetch): Promise<CodexPluginCatalogBucketRelease> {
  const response = await fetchDesktopBucketResource(codexPluginCatalogBucketIndexUrl(), {
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(indexTimeoutMs),
  }, fetchImplementation)
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`插件目录清单返回 HTTP ${response.status}`)
  }
  const release = parseCodexPluginCatalogBucketIndex(await readBoundedResponseText(response, maximumIndexBytes, '插件目录清单'))
  if (!release) throw new Error('插件目录清单格式对不上')
  return release
}

export interface CodexPluginCatalogBucketOptions {
  /** 测试接缝：时钟、判「太慢」的门槛和两种等待。 */
  now?: () => number
  limitMs?: number
  idleMs?: number
  totalMs?: number
}

async function readArchive(
  release: CodexPluginCatalogBucketRelease,
  fetchImplementation: typeof fetch,
  options: CodexPluginCatalogBucketOptions,
): Promise<Buffer> {
  const now = options.now ?? Date.now
  const stop = new AbortController()
  const total = setTimeout(() => stop.abort(new Error('从存储桶下载插件目录超时')), options.totalMs ?? archiveTotalMs)
  let idle: NodeJS.Timeout | undefined
  function armIdle(): void {
    clearTimeout(idle)
    idle = setTimeout(() => stop.abort(new Error('从存储桶下载插件目录时连接停住了')), options.idleMs ?? archiveIdleMs)
  }
  try {
    armIdle()
    const response = await fetchDesktopBucketResource(release.url, {
      headers: { Accept: 'application/gzip, application/octet-stream' },
      signal: stop.signal,
    }, fetchImplementation)
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error(`存储桶返回 HTTP ${response.status}`)
    }
    const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    const declared = Number(response.headers.get('content-length'))
    if (!archiveContentTypes.has(type) || declared !== release.bytes || !response.body) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error(`存储桶返回的插件目录和清单对不上（类型 ${type || '缺失'}，大小 ${response.headers.get('content-length') ?? '没写'}）`)
    }
    const reader = response.body.getReader()
    const hash = createHash('sha256')
    const chunks: Buffer[] = []
    const startedAt = now()
    let received = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        if (!chunk.value?.byteLength) continue
        armIdle()
        received += chunk.value.byteLength
        // 清单写了多大就只收这么多：多一个字节都不是它说的那份。
        if (received > release.bytes) throw new Error('存储桶返回的数据比清单里写的大')
        const data = Buffer.from(chunk.value)
        hash.update(data)
        chunks.push(data)
        if (isDesktopBucketDownloadTooSlow(now() - startedAt, received, release.bytes, options.limitMs ?? codexCatalogBucketDownloadLimitMs)) {
          throw new Error('从存储桶下载插件目录太慢')
        }
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined)
      throw error
    } finally {
      reader.releaseLock()
    }
    if (received !== release.bytes) throw new Error(`存储桶的插件目录没下完：应为 ${release.bytes} 字节，实际 ${received} 字节`)
    if (hash.digest('hex') !== release.sha256) throw new Error('存储桶的插件目录 SHA-256 和清单不一致')
    return Buffer.concat(chunks, received)
  } catch (error) {
    // An abort surfaces as the stream's own error; report the reason we aborted for.
    if (stop.signal.aborted && stop.signal.reason instanceof Error) throw stop.signal.reason
    throw error
  } finally {
    clearTimeout(total)
    clearTimeout(idle)
  }
}

/**
 * 读桶里的清单、下那份压缩包、核大小和 SHA-256。任何一步没走通都抛 DesktopBucketUnavailableError，
 * 解压和核目录内容由调用方照 GitHub 那一份的规矩做。
 */
export async function downloadCodexPluginCatalogFromBucket(
  fetchImplementation: typeof fetch,
  options: CodexPluginCatalogBucketOptions = {},
): Promise<CodexPluginCatalogBucketDownload> {
  try {
    const release = await readRelease(fetchImplementation)
    return { commit: release.commit, compressed: await readArchive(release, fetchImplementation, options) }
  } catch (error) {
    if (error instanceof DesktopBucketUnavailableError) throw error
    const detail = error instanceof Error && error.name === 'TimeoutError' ? '读取插件目录清单超时'
      : error instanceof Error ? error.message : String(error)
    throw new DesktopBucketUnavailableError(detail || '存储桶这一路没走通', error)
  }
}

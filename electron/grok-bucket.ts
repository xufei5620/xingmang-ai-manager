import { readBoundedResponseText } from './bounded-response'
import { DesktopBucketUnavailableError, desktopPackageBucketOrigin, fetchDesktopBucketResource } from './desktop-package-bucket'
import { parseGrokStableVersion, resolveGrokInstallVersion } from './grok-update'

/**
 * 星芒存储桶里的 Windows 版 Grok：scripts/sync-grok-cos.cjs 定时问 xAI 现在的 stable，连同星芒的推荐版本，
 * 把 xAI 签过名的 grok.exe 原样传上来（在 GitHub 的 Windows 机器上核过 xAI 的签名才传），清单里写着
 * 每一版每种芯片的大小和 SHA-256。装 Grok 时先从这里下：国内快，用不着加速（yoyo 2026-10-14「放桶」）。
 * 读不到、没有要的那一版、对不上都抛 DesktopBucketUnavailableError，调用方悄悄换回 xAI 那一路。
 *
 * Trust: the bucket origin and the index key are constants, and every request goes through
 * fetchDesktopBucketResource, which pins the host and path and refuses redirects (I10). The
 * index only names an object key with exactly the layout the sync script writes. Its size and
 * SHA-256 bind the download, and the caller still runs the same xAI Authenticode check it
 * runs on xAI's own copy before anything is installed. Whoever could rewrite the bucket could
 * at most serve a different xAI-signed build under this version's name; the version.json the
 * installer writes would then be wrong until the next update, but unsigned code never runs.
 */

const indexKey = 'xingmang/offline/grok/latest.json'
const objectPrefix = 'xingmang/offline/grok'
const maximumIndexBytes = 256 * 1024
const indexTimeoutMs = 10_000
// 同 grok-installer.ts 收 xAI 那一份时的上下限。
const minimumBinaryBytes = 1024 * 1024
const maximumBinaryBytes = 512 * 1024 * 1024
const maximumReleases = 32
const binaryContentType = 'application/octet-stream'

const platforms = {
  x64: { platformId: 'windows-x64', artifact: 'windows-x86_64' },
  arm64: { platformId: 'windows-arm64', artifact: 'windows-aarch64' },
} as const

export interface GrokBucketRelease {
  version: string
  url: string
  bytes: number
  /** Lower-case hex. */
  sha256: string
  contentType: typeof binaryContentType
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function objectUrl(key: string): string {
  return `${desktopPackageBucketOrigin}/${key}`
}

export function grokBucketIndexUrl(): string {
  return objectUrl(indexKey)
}

/**
 * 从桶里的清单原文挑出要装的那一版：没点名就是清单里的 stable，点名的就是那一版。这台电脑的芯片、
 * 版本有一处对不上就是 null。点名的版本比桶里的 stable 新也是 null：桶是定时同步的，xAI 可能已经把它
 * 定成 stable 了，这时装桶里的 stable 等于悄悄装旧，交给 xAI 那一路按真正的 stable 定
 * （resolveGrokInstallVersion）。点名的版本号本身无效时照旧抛错，和 xAI 那一路一样。
 */
export function parseGrokBucketIndex(text: string, architecture: NodeJS.Architecture, requestedVersion?: string): GrokBucketRelease | null {
  const platform = architecture === 'x64' || architecture === 'arm64' ? platforms[architecture] : null
  if (!platform || !text.trim() || Buffer.byteLength(text, 'utf8') > maximumIndexBytes) return null
  let root: unknown
  try { root = JSON.parse(text) } catch { return null }
  if (!isRecord(root) || root.schemaVersion !== 1 || root.product !== 'grok-cli' || !isRecord(root.stable)
    || typeof root.stable.version !== 'string' || !Array.isArray(root.releases) || root.releases.length > maximumReleases) return null
  const stable = parseGrokStableVersion(root.stable.version)
  if (!stable) return null
  const version = resolveGrokInstallVersion(requestedVersion, stable)
  const wanted = requestedVersion?.trim()
  if (wanted && wanted !== 'latest' && wanted !== version) return null
  const releases = root.releases.filter((release) => isRecord(release) && release.version === version)
  if (releases.length !== 1 || !isRecord(releases[0]) || !Array.isArray(releases[0].files)) return null
  const files = releases[0].files.filter((file) => isRecord(file) && file.platformId === platform.platformId)
  if (files.length !== 1 || !isRecord(files[0])) return null
  const file = files[0]
  const sha256 = file.sha256
  if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) return null
  const key = `${objectPrefix}/${platform.platformId}/sha256-${sha256}/grok-${version}-${platform.artifact}.exe`
  const bytes = file.bytes
  if (
    file.platform !== 'windows'
    || file.architecture !== architecture
    || file.key !== key
    || file.url !== objectUrl(key)
    || file.contentType !== binaryContentType
    || file.verification !== 'windows-authenticode-xai'
    || typeof bytes !== 'number'
    || !Number.isSafeInteger(bytes)
    || bytes < minimumBinaryBytes
    || bytes > maximumBinaryBytes
  ) return null
  return { version, url: objectUrl(key), bytes, sha256, contentType: binaryContentType }
}

/**
 * 读桶里的清单，挑出这台电脑要装的那一版。读不到、太慢、桶里没有这一版都抛 DesktopBucketUnavailableError；
 * 客户点了取消就原样抛 signal 的 reason。
 */
export async function readGrokBucketRelease(
  architecture: NodeJS.Architecture,
  requestedVersion: string | undefined,
  fetchImplementation: typeof fetch,
  signal?: AbortSignal,
): Promise<GrokBucketRelease> {
  const timeout = AbortSignal.timeout(indexTimeoutMs)
  try {
    const response = await fetchDesktopBucketResource(grokBucketIndexUrl(), {
      headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    }, fetchImplementation)
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error(`Grok 清单返回 HTTP ${response.status}`)
    }
    const release = parseGrokBucketIndex(await readBoundedResponseText(response, maximumIndexBytes, 'Grok 清单'), architecture, requestedVersion)
    if (!release) throw new Error('存储桶里没有要装的这一版 Grok，或清单格式对不上')
    return release
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? new Error('下载已取消')
    if (timeout.aborted) throw new DesktopBucketUnavailableError('读取 Grok 清单超时', error)
    throw new DesktopBucketUnavailableError(error instanceof Error ? error.message : String(error), error)
  }
}

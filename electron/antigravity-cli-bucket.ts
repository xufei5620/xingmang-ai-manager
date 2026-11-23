import { buildAntigravityCliArtifactUrl, type AntigravityCliPlatform, type AntigravityCliRelease } from './antigravity-cli-release'
import { readBoundedResponseText } from './bounded-response'
import {
  describeStaleDesktopBucketIndex, desktopBucketResponseTime, DesktopBucketUnavailableError, desktopPackageBucketOrigin,
  fetchDesktopBucketResource, isDesktopBucketIndexStale,
} from './desktop-package-bucket'
import { isRecord } from './input-guards'

/**
 * 星芒存储桶里的 agy：scripts/sync-antigravity-cli-cos.cjs 每 6 小时问一次谷歌的版本清单，把谷歌签过名的原件
 * 原样传上来（Windows 的在 GitHub 的 Windows 机器上核过 Authenticode，Mac 的在 Mac 机器上核过 codesign），
 * Windows、Mac 各一份清单。装 agy 时先从这里下：谷歌的两个站国内都连不上（方案第三节第 4 条）。
 * 读不到、对不上、过期都抛 DesktopBucketUnavailableError，调用方悄悄换回谷歌那一路。
 *
 * Trust: the bucket origin and both index keys are constants, and every request goes through
 * fetchDesktopBucketResource, which pins the host and path and refuses redirects (I10). An entry
 * is only accepted when its object key has exactly the layout the sync script writes and its
 * recorded source is exactly the Google artifact URL for that version and build. Its size and
 * SHA-256 bind the download; the installer still checks Google's code signature on what it
 * installs, so whoever could rewrite the bucket could at most serve a different Google-signed
 * build, never unsigned code.
 */

const objectPrefix = 'xingmang/offline/antigravity-cli'
const maximumIndexBytes = 128 * 1024
const indexTimeoutMs = 10_000
// 同步作业留最近 4 版；多留几格余量，免得那边改了数这边就全换回谷歌。
const maximumReleases = 16
// 同 scripts/sync-antigravity-cli-cos.cjs 收谷歌那一份时的上下限（1.5.15 的 Windows 程序两百三四十 MB）。
export const minimumAntigravityCliArtifactBytes = 1024 * 1024
export const maximumAntigravityCliArtifactBytes = 512 * 1024 * 1024

type AntigravityCliFamily = 'windows' | 'macos'

interface AntigravityCliBucketLayout {
  family: AntigravityCliFamily
  platformId: string
  architecture: 'x64' | 'arm64'
  extension: 'exe' | 'tar.gz'
  contentType: 'application/octet-stream' | 'application/gzip'
  verification: 'windows-authenticode-google' | 'macos-developer-id-google'
}

const layouts: Record<AntigravityCliPlatform, AntigravityCliBucketLayout> = {
  windows_amd64: { family: 'windows', platformId: 'windows-x64', architecture: 'x64', extension: 'exe', contentType: 'application/octet-stream', verification: 'windows-authenticode-google' },
  windows_arm64: { family: 'windows', platformId: 'windows-arm64', architecture: 'arm64', extension: 'exe', contentType: 'application/octet-stream', verification: 'windows-authenticode-google' },
  darwin_amd64: { family: 'macos', platformId: 'macos-x64', architecture: 'x64', extension: 'tar.gz', contentType: 'application/gzip', verification: 'macos-developer-id-google' },
  darwin_arm64: { family: 'macos', platformId: 'macos-arm64', architecture: 'arm64', extension: 'tar.gz', contentType: 'application/gzip', verification: 'macos-developer-id-google' },
}

const versionPattern = /^(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})$/
const buildPattern = /^[1-9]\d{0,24}$/

export interface AntigravityCliBucketRelease {
  platform: AntigravityCliPlatform
  version: string
  build: string
  url: string
  bytes: number
  /** Lower-case hex. */
  sha256: string
  /** Lower-case hex, the same value Google's manifest gives for this file. */
  sha512: string
  contentType: AntigravityCliBucketLayout['contentType']
  packaging: AntigravityCliRelease['packaging']
  /** 同步作业最后一次问过谷歌、核过这份清单的时间（ISO 8601）。 */
  checkedAt?: string
}

function objectUrl(key: string): string {
  return `${desktopPackageBucketOrigin}/${key}`
}

export function antigravityCliBucketIndexUrl(platform: AntigravityCliPlatform): string {
  return objectUrl(`${objectPrefix}/${layouts[platform].family}.json`)
}

/**
 * 从桶里的清单原文挑出这台电脑要装的那一份：清单里最新的那一版（同步作业按版本从新到旧写）。
 * 有一处对不上就是 null，交给谷歌那一路。
 */
export function parseAntigravityCliBucketIndex(text: string, platform: AntigravityCliPlatform): AntigravityCliBucketRelease | null {
  const layout = layouts[platform]
  if (!text.trim() || Buffer.byteLength(text, 'utf8') > maximumIndexBytes) return null
  let root: unknown
  try { root = JSON.parse(text) } catch { return null }
  if (!isRecord(root) || root.schemaVersion !== 1 || root.product !== 'antigravity-cli' || root.family !== layout.family
    || !Array.isArray(root.releases) || root.releases.length === 0 || root.releases.length > maximumReleases) return null
  const release = root.releases[0]
  if (!isRecord(release) || typeof release.version !== 'string' || !versionPattern.test(release.version)
    || typeof release.build !== 'string' || !buildPattern.test(release.build) || !Array.isArray(release.files)) return null
  const { version, build } = release
  const files = release.files.filter((file) => isRecord(file) && file.platformId === layout.platformId)
  if (files.length !== 1 || !isRecord(files[0])) return null
  const file = files[0]
  const { sha256, sha512, bytes } = file
  if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) return null
  if (typeof sha512 !== 'string' || !/^[a-f0-9]{128}$/.test(sha512)) return null
  const key = `${objectPrefix}/${layout.platformId}/sha256-${sha256}/agy-${version}-${layout.platformId}.${layout.extension}`
  if (
    file.platform !== layout.family
    || file.architecture !== layout.architecture
    || file.manifest !== platform
    || file.key !== key
    || file.url !== objectUrl(key)
    || file.contentType !== layout.contentType
    || file.verification !== layout.verification
    || file.sourceUrl !== buildAntigravityCliArtifactUrl(platform, version, build)
    || typeof bytes !== 'number'
    || !Number.isSafeInteger(bytes)
    || bytes < minimumAntigravityCliArtifactBytes
    || bytes > maximumAntigravityCliArtifactBytes
  ) return null
  return {
    platform, version, build, url: objectUrl(key), bytes, sha256, sha512, contentType: layout.contentType,
    packaging: layout.extension === 'exe' ? 'executable' : 'tar.gz',
    ...(typeof root.checkedAt === 'string' ? { checkedAt: root.checkedAt } : {}),
  }
}

/**
 * 读桶里这台电脑那一份清单，挑出最新的那一版。读不到、太慢、对不上、过期（isDesktopBucketIndexStale：
 * 连着几次没同步上时桶里的可能比谷歌旧）都抛 DesktopBucketUnavailableError；客户点了取消就原样抛
 * signal 的 reason。
 */
export async function readAntigravityCliBucketRelease(
  platform: AntigravityCliPlatform,
  fetchImplementation: typeof fetch,
  signal?: AbortSignal,
): Promise<AntigravityCliBucketRelease> {
  const timeout = AbortSignal.timeout(indexTimeoutMs)
  try {
    const response = await fetchDesktopBucketResource(antigravityCliBucketIndexUrl(platform), {
      headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    }, fetchImplementation)
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error(`Antigravity 命令行清单返回 HTTP ${response.status}`)
    }
    const release = parseAntigravityCliBucketIndex(await readBoundedResponseText(response, maximumIndexBytes, 'Antigravity 命令行清单'), platform)
    if (!release) throw new Error('存储桶里没有这台电脑能装的 Antigravity 命令行，或清单格式对不上')
    if (isDesktopBucketIndexStale(release.checkedAt, desktopBucketResponseTime(response))) throw new Error(describeStaleDesktopBucketIndex(release.checkedAt))
    return release
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? new Error('下载已取消')
    if (timeout.aborted) throw new DesktopBucketUnavailableError('读取 Antigravity 命令行清单超时', error)
    throw new DesktopBucketUnavailableError(error instanceof Error ? error.message : String(error), error)
  }
}

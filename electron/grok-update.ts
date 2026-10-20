import { readBoundedResponseBytes } from './bounded-response'
import { fetchLandingWithRedirectAllowlist } from './redirect-allowlist-fetch'
import { isNewerVersion } from './versions'

const grokStablePrimaryUrl = 'https://x.ai/cli/stable'
const grokStableFallbackUrl = 'https://storage.googleapis.com/grok-build-public-artifacts/cli/stable'
const allowedGrokStableUrls = new Set([grokStablePrimaryUrl, grokStableFallbackUrl])
const defaultTimeoutMs = 6_000
const maximumResponseBytes = 1024
const maximumRedirects = 2

export const grokStableVersionUrls = [grokStablePrimaryUrl, grokStableFallbackUrl] as const

export type GrokVersionFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export interface GrokStableVersionResult {
  version: string
  sourceUrl: string
}

export interface GrokStableVersionFetchOptions {
  fetchImpl?: GrokVersionFetch
  timeoutMs?: number
  /**
   * 置位表示这次查询的结果已经没人要了（例如整批最新版探测的预算到点了）。手里那次
   * 请求照旧跑完，它还可能给缓存留下有用的结果；但不再往备用源发新的请求——否则一次
   * 被丢弃的探测会在后台继续出网，在测试里还会串进后面的用例。
   */
  abandonedSignal?: AbortSignal
}

function validateOfficialUrl(value: string): URL {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('Grok 版本地址格式无效')
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.port
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || !allowedGrokStableUrls.has(parsed.href)
  ) {
    throw new Error(`Grok 版本查询拒绝不受信任的地址：${parsed.origin}`)
  }
  return parsed
}

export function parseGrokStableVersion(value: string): string | null {
  const version = value.trim()
  return version.length <= 80
    && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z](?:[0-9A-Za-z.-]{0,62})?)?$/.test(version)
    ? version
    : null
}

// 已验证版本名单与「退回更新前的版本」会点名一个 Grok 版本。xAI 的 stable 清单仍是
// 上限：点名的版本比它新时装 stable，不装一个 xAI 还没放到稳定通道的版本；比它旧时
// 照装——旧版本的二进制仍在同一个官方下载目录里，签名校验一步不少。只收 x.y.z：
// 预发布号在比较里排在正式版前面，带后缀的版本会从这个上限底下钻过去。
export function resolveGrokInstallVersion(requested: string | null | undefined, stableVersion: string): string {
  const named = resolveGrokNamedVersion(requested)
  if (!named) return stableVersion
  return isNewerVersion(stableVersion, named) ? stableVersion : named
}

// 两个 stable 地址都查不到时，xAI 那一路靠它定版本号（#1061 第 4 条，yoyo 2026-10-20「四条都放」）：
// 点了名的照装，只是少了上面那道「不超过 stable」的上限；没点名（装最新）没有版本可装，返回 null。
// 格式照旧只收 x.y.z，下回来的文件照旧核大小、SHA-256 和 xAI 签名。
export function resolveGrokNamedVersion(requested: string | null | undefined): string | null {
  const wanted = requested?.trim()
  if (!wanted || wanted === 'latest') return null
  if (!/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(wanted)) throw new Error('指定的 Grok 版本号无效')
  return wanted
}

async function readBoundedText(response: Response): Promise<string> {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
  if (contentType !== 'text/plain') throw new Error('Grok 版本服务未返回纯文本')
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null && !/^\d+$/.test(declaredLength)) throw new Error('Grok 版本响应 Content-Length 无效')
  const bytes = await readBoundedResponseBytes(response, maximumResponseBytes, 'Grok 版本', {
    oversizeMessage: 'Grok 版本响应超过 1 KiB 安全上限',
  })
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

function fetchErrorMessage(error: unknown): string {
  const candidate = error as { name?: unknown; message?: unknown }
  if (candidate?.name === 'AbortError') return '查询超时'
  const message = typeof candidate?.message === 'string' ? candidate.message : String(error)
  return message.replace(/\s+/g, ' ').trim().slice(0, 300) || '查询失败'
}

async function fetchSource(
  sourceUrl: string,
  fetchImpl: GrokVersionFetch,
  timeoutMs: number,
): Promise<GrokStableVersionResult> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  timeout.unref?.()
  try {
    // sourceUrl picks the official directory the binary comes from (buildGrokArtifactUrls),
    // so it is the hop that answered, not the one first asked.
    const { response, url } = await fetchLandingWithRedirectAllowlist(sourceUrl, {
      method: 'GET',
      headers: { Accept: 'text/plain' },
      signal: controller.signal,
    }, fetchImpl, {
      label: 'Grok 版本服务',
      maximumRedirects,
      validate: validateOfficialUrl,
      messages: {
        loop: 'Grok 版本服务返回了循环重定向',
        bypass: 'Grok 版本服务绕过了受限重定向策略',
      },
    })
    if (!response.ok) throw new Error(`Grok 版本服务返回 HTTP ${response.status}`)
    const version = parseGrokStableVersion(await readBoundedText(response))
    if (!version) throw new Error('Grok 版本服务返回了无效版本文本')
    return { version, sourceUrl: url.href }
  } finally {
    clearTimeout(timeout)
  }
}

export async function fetchGrokStableVersion(
  options: GrokStableVersionFetchOptions = {},
): Promise<GrokStableVersionResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new TypeError('Grok 版本查询超时必须是 1 到 30000 毫秒的整数')
  }
  const errors: string[] = []
  for (const sourceUrl of grokStableVersionUrls) {
    try {
      return await fetchSource(sourceUrl, fetchImpl, timeoutMs)
    } catch (error) {
      errors.push(`${new URL(sourceUrl).hostname}：${fetchErrorMessage(error)}`)
    }
    if (options.abandonedSignal?.aborted) break
  }
  throw new Error(`Grok 官方版本查询失败：${errors.join('；')}`)
}

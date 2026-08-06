const grokStablePrimaryUrl = 'https://x.ai/cli/stable'
const grokStableFallbackUrl = 'https://storage.googleapis.com/grok-build-public-artifacts/cli/stable'
const allowedGrokStableUrls = new Set([grokStablePrimaryUrl, grokStableFallbackUrl])
const redirectStatuses = new Set([301, 302, 303, 307, 308])
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

async function readBoundedText(response: Response): Promise<string> {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
  if (contentType !== 'text/plain') throw new Error('Grok 版本服务未返回纯文本')
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength)) throw new Error('Grok 版本响应 Content-Length 无效')
    if (Number(declaredLength) > maximumResponseBytes) {
      throw new Error('Grok 版本响应超过 1 KiB 安全上限')
    }
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      if (!chunk.value?.byteLength) continue
      received += chunk.value.byteLength
      if (received > maximumResponseBytes) {
        await reader.cancel().catch(() => undefined)
        throw new Error('Grok 版本响应超过 1 KiB 安全上限')
      }
      chunks.push(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
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
  let current = validateOfficialUrl(sourceUrl)
  const visited = new Set<string>()
  try {
    for (let redirectCount = 0; redirectCount <= maximumRedirects; redirectCount += 1) {
      if (visited.has(current.href)) throw new Error('Grok 版本服务返回了循环重定向')
      visited.add(current.href)
      const response = await fetchImpl(current, {
        method: 'GET',
        headers: { Accept: 'text/plain' },
        redirect: 'manual',
        signal: controller.signal,
      })
      if (response.url) {
        const responseUrl = validateOfficialUrl(response.url)
        if (responseUrl.href !== current.href) {
          throw new Error('Grok 版本服务绕过了受限重定向策略')
        }
      }
      if (redirectStatuses.has(response.status)) {
        if (redirectCount === maximumRedirects) throw new Error('Grok 版本服务重定向次数过多')
        const location = response.headers.get('location')
        if (!location) throw new Error('Grok 版本服务重定向缺少 Location')
        current = validateOfficialUrl(new URL(location, current).href)
        continue
      }
      if (!response.ok) throw new Error(`Grok 版本服务返回 HTTP ${response.status}`)
      const version = parseGrokStableVersion(await readBoundedText(response))
      if (!version) throw new Error('Grok 版本服务返回了无效版本文本')
      return { version, sourceUrl: current.href }
    }
    throw new Error('Grok 版本服务重定向次数过多')
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
  }
  throw new Error(`Grok 官方版本查询失败：${errors.join('；')}`)
}

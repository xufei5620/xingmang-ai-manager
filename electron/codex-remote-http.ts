import { raceAbort, readBoundedResponseText } from './bounded-response'

// 遥控渠道（飞书、微信）对平台发的每一个请求都走这里：只去点名的 https origin、超时、
// 响应体上限、不跟重定向（I10）。平台接口从不重定向，拿到 3xx 说明被门户或劫持页截了，
// 带着 App Secret 或机器人令牌跟过去就是把凭据交给别人。

export interface RemoteJsonRequest {
  fetch: typeof fetch
  url: string
  /** 只许去这几个 origin（如 https://open.feishu.cn），全等比较。 */
  allowedOrigins: readonly string[]
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  headers?: Record<string, string>
  body?: unknown
  timeoutMs: number
  maxResponseBytes: number
  /** 报错里用的中文名，如「飞书」。 */
  label: string
  signal?: AbortSignal
  /** 缺省 JSON.parse。iLink 的消息编号是 64 位整数，那边要传一个不丢精度的解析函数。 */
  parseJson?: (text: string) => unknown
}

export interface RemoteJsonResponse {
  status: number
  ok: boolean
  /** 解析不了 JSON 时是 null。 */
  payload: unknown
}

const redirectStatuses = new Set([301, 302, 303, 307, 308])

export class RemoteHttpError extends Error {
  constructor(
    message: string,
    readonly reason: 'blocked-url' | 'redirected' | 'timeout' | 'aborted' | 'network' | 'oversize',
  ) {
    super(message)
    this.name = 'RemoteHttpError'
  }
}

export function assertAllowedRemoteUrl(url: string, allowedOrigins: readonly string[], label: string): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new RemoteHttpError(`${label}请求地址无效`, 'blocked-url')
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !allowedOrigins.includes(parsed.origin)) {
    throw new RemoteHttpError(`${label}请求地址不在允许范围内，已拒绝`, 'blocked-url')
  }
  return parsed
}

export async function requestRemoteJson(request: RemoteJsonRequest): Promise<RemoteJsonResponse> {
  const url = assertAllowedRemoteUrl(request.url, request.allowedOrigins, request.label)
  const controller = new AbortController()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, request.timeoutMs)
  timeout.unref?.()
  const onOuterAbort = () => controller.abort()
  request.signal?.addEventListener('abort', onOuterAbort, { once: true })
  if (request.signal?.aborted) controller.abort()
  try {
    const response = await raceAbort(request.fetch(url, {
      method: request.method,
      headers: {
        Accept: 'application/json',
        ...(request.body !== undefined ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
        ...request.headers,
      },
      body: request.body !== undefined ? JSON.stringify(request.body) : undefined,
      credentials: 'omit',
      redirect: 'manual',
      signal: controller.signal,
    }), controller.signal)
    if (response.url && new URL(response.url).origin !== url.origin) {
      throw new RemoteHttpError(`${request.label}请求被重定向到别的地址，已拒绝`, 'redirected')
    }
    if (response.type === 'opaqueredirect' || redirectStatuses.has(response.status)) {
      await response.body?.cancel().catch(() => undefined)
      throw new RemoteHttpError(`${request.label}请求被重定向，已拒绝`, 'redirected')
    }
    let text: string
    try {
      text = await readBoundedResponseText(response, request.maxResponseBytes, request.label, {
        guard: { signal: controller.signal },
      })
    } catch (error) {
      if (controller.signal.aborted) throw error
      throw new RemoteHttpError(error instanceof Error ? error.message : `${request.label}响应读取失败`, 'oversize')
    }
    let payload: unknown = null
    if (text) {
      try {
        payload = (request.parseJson ?? JSON.parse)(text)
      } catch {
        payload = null
      }
    }
    return { status: response.status, ok: response.ok, payload }
  } catch (error) {
    if (error instanceof RemoteHttpError) throw error
    if (timedOut) throw new RemoteHttpError(`${request.label}请求超时`, 'timeout')
    if (request.signal?.aborted) throw new RemoteHttpError(`${request.label}请求已取消`, 'aborted')
    // 上游原文可能带着地址里的参数，不往外抛原文，只给一句中文。
    throw new RemoteHttpError(`连不上${request.label}，请检查网络`, 'network')
  } finally {
    clearTimeout(timeout)
    request.signal?.removeEventListener('abort', onOuterAbort)
  }
}

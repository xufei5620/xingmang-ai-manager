/**
 * Every installer download here walks its own redirects: it asks for
 * `redirect: 'manual'`, checks each Location against that installer's host
 * allowlist, and only then requests the next hop (I10). Under undici -- the
 * tests, and the main process's own fetch -- 'manual' hands back the 3xx with
 * its Location. Electron's net.fetch does not: it passes the mode straight to
 * a ClientRequest, which emits 'redirect' and, because nobody inside net.fetch
 * calls followRedirect(), dies with "Redirect was cancelled" (Electron 43,
 * lib/common/api/net-client-request.ts; reproduced on 43.6.0). Production
 * downloads go through net.fetch so that they follow the system proxy, so the
 * first redirect of every such download failed: Git for Windows (npmmirror and
 * GitHub both redirect), the Claude Desktop MSIX entry point, npmmirror's
 * Node.js mirror.
 *
 * This wraps a fetch so that 'manual' behaves the way undici's does: a redirect
 * comes back as a bodiless 3xx Response carrying the Location, and the request
 * is cancelled right there, so nothing is fetched from the new location until
 * the caller has checked it and asked again. Every other mode, and any request
 * with a body, goes to the wrapped fetch untouched.
 *
 * The response half mirrors Electron's own net-fetch.ts, so a non-redirect
 * answer streams and aborts exactly as net.fetch's would. Like net.fetch's, its
 * `url` is empty; callers already only check `response.url` when it is set.
 */
import { Readable } from 'node:stream'

/** What this module needs from Electron's net.request options; Electron adds the session. */
export interface ManualRedirectRequestOptions {
  method: string
  url: string
  redirect: 'manual'
  credentials: 'include' | 'omit'
  cache: RequestCache
}

/** The fields of Electron's IncomingMessage this module reads; at runtime it is a Readable. */
export interface ManualRedirectIncomingMessage {
  statusCode: number
  statusMessage: string
  headers: Record<string, string | string[]>
}

/** The part of Electron's ClientRequest this module drives. */
export interface ManualRedirectClientRequest {
  setHeader(name: string, value: string): void
  on(event: 'redirect', listener: (statusCode: number, method: string, redirectUrl: string) => void): this
  on(event: 'response', listener: (response: ManualRedirectIncomingMessage) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  abort(): void
  end(): void
}

export type ManualRedirectRequestFactory = (options: ManualRedirectRequestOptions) => ManualRedirectClientRequest

// Responses with these statuses cannot carry a body (Fetch standard); net-fetch.ts uses the same list.
const nullBodyStatuses: ReadonlySet<number> = new Set([101, 204, 205, 304])

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
}

function responseHeaders(source: Record<string, string | string[]>): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(source)) {
    headers.set(name, Array.isArray(value) ? value.join(', ') : value)
  }
  return headers
}

function fetchWithManualRedirect(request: Request, start: ManualRedirectRequestFactory): Promise<Response> {
  const signal = request.signal
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise<Response>((resolve, reject) => {
    let settled = false
    function settle(outcome: () => void): void {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      outcome()
    }
    // Without an Origin, net-fetch.ts sends 'same-origin' as 'include' too; the session's own cookies only.
    const clientRequest = start({
      method: request.method,
      url: request.url,
      redirect: 'manual',
      credentials: request.credentials === 'omit' ? 'omit' : 'include',
      cache: request.cache,
    })
    function onAbort(): void {
      settle(() => reject(abortReason(signal)))
      clientRequest.abort()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    for (const [name, value] of request.headers) clientRequest.setHeader(name, value)
    clientRequest.on('redirect', (statusCode, _method, redirectUrl) => {
      // Aborting inside the listener is what stops Electron from following it or calling it cancelled.
      clientRequest.abort()
      settle(() => resolve(new Response(null, { status: statusCode, headers: { location: redirectUrl } })))
    })
    clientRequest.on('response', (message) => {
      if (settled) return
      const body = nullBodyStatuses.has(message.statusCode) || request.method === 'HEAD'
        ? null
        // Electron types IncomingMessage as a plain EventEmitter, but it is a Readable; net-fetch.ts converts it the same way.
        : Readable.toWeb(message as unknown as Readable) as ReadableStream<Uint8Array>
      // Later aborts still reach the request and, through it, this body (net-fetch.ts does the same).
      signal.removeEventListener('abort', onAbort)
      signal.addEventListener('abort', () => clientRequest.abort(), { once: true })
      settled = true
      resolve(new Response(body, { status: message.statusCode, statusText: message.statusMessage, headers: responseHeaders(message.headers) }))
    })
    clientRequest.on('error', (error) => settle(() => reject(error)))
    clientRequest.end()
  })
}

export function createManualRedirectFetch(fetchImplementation: typeof fetch, start: ManualRedirectRequestFactory): typeof fetch {
  return (input, init) => {
    if (init?.redirect !== 'manual') return fetchImplementation(input, init)
    let request: Request
    try {
      request = new Request(input, init)
    } catch (error) {
      return Promise.reject(error)
    }
    // Downloads never send a body; anything that does keeps the wrapped fetch's behaviour.
    if (request.body !== null) return fetchImplementation(input, init)
    return fetchWithManualRedirect(request, start)
  }
}

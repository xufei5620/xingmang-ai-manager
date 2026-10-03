/**
 * 星芒自己更新时，electron-updater 6.8.9 的请求在 Electron 43 里有三个缺口，都在沙箱里用
 * Electron 43.6.0 对着中途停发、中途断开的本地服务器（HTTP/1.1 和 HTTP/2）实测过：
 *
 * - 它自带的请求超时从来不生效：builder-util-runtime 在请求的 'socket' 事件里挂超时，
 *   Electron 的 net 请求不发这个事件。
 * - 增量下载（只下改了的那几段）停住以后不认取消令牌：令牌只在又来了数据时才查。
 * - 增量下载一次要好几段的那个响应没挂 'error' 监听：连接中途断开（换网络、代理软件重启）
 *   就成了没人接的异常，main.ts 会把它当主进程意外出错，退出再重开。
 *
 * Wrapping the executor's createRequest closes all three from outside the library.
 * Every request it creates is tracked until its response ends. Bytes arriving on any
 * of them are timestamped for the stall watchdog in updater.ts, which otherwise only
 * sees progress events, and electron-updater sends none for blockmaps, for
 * single-range differential batches or for a response without a Content-Length.
 * Each response gets a no-op 'error' listener: Electron reports the same failure as
 * an 'error' on the request, which every download path already rejects on, so the
 * response's copy only has to stop being uncaught. abortAll fails the tracked
 * requests the way a network error does: an 'error' on the request, then abort()
 * to cancel the transfer and release the connection.
 *
 * Only electron-updater's own executor is wrapped. Requests made elsewhere on the
 * updater session (the service-status fetch) are not touched.
 */

export interface UpdateRequestGuard {
  /** 最近一次有更新请求收到响应头或数据的时间（毫秒）；一次都还没有为 null。 */
  lastReceivedAt(): number | null
  /** 让还开着的更新请求都以 reason 失败、断开连接；返回断开了几个。 */
  abortAll(reason: Error): number
}

interface RequestExecutor {
  createRequest: (options: unknown, callback: (response: unknown) => void) => unknown
}

interface EventSource {
  on(event: string, listener: (...args: unknown[]) => void): unknown
}

interface TrackedRequest extends EventSource {
  emit(event: string, ...args: unknown[]): boolean
  abort(): void
}

function isEventSource(value: unknown): value is EventSource {
  return typeof value === 'object' && value !== null && 'on' in value && typeof value.on === 'function'
}

function isTrackedRequest(value: unknown): value is TrackedRequest {
  return isEventSource(value)
    && 'emit' in value && typeof value.emit === 'function'
    && 'abort' in value && typeof value.abort === 'function'
}

function isRequestExecutor(value: unknown): value is RequestExecutor {
  return typeof value === 'object' && value !== null
    && 'createRequest' in value && typeof value.createRequest === 'function'
}

/**
 * Wraps `executor.createRequest`. In electron-updater that is the one place every
 * update request is made: the check, the blockmaps, both kinds of differential
 * request and the full download. Returns null, wrapping nothing, when `executor`
 * has no createRequest.
 */
export function createUpdateRequestGuard(executor: unknown, now: () => number = Date.now): UpdateRequestGuard | null {
  if (!isRequestExecutor(executor)) return null
  const open = new Set<TrackedRequest>()
  let receivedAt: number | null = null
  const received = () => { receivedAt = now() }
  const track = (request: TrackedRequest) => {
    open.add(request)
    const forget = () => { open.delete(request) }
    // Electron's ClientRequest emits 'close' as soon as the request has been sent,
    // long before the response, so the end of a request is read off its response.
    // This listener is also why abortAll's emit never throws for want of one.
    request.on('error', forget)
    request.on('abort', forget)
    request.on('response', (response) => {
      received()
      if (!isEventSource(response)) return
      response.on('error', () => {})
      response.on('data', received)
      response.on('end', forget)
      response.on('close', forget)
    })
  }
  const createRequest = executor.createRequest
  executor.createRequest = (options, callback) => {
    const request = createRequest.call(executor, options, callback)
    if (isTrackedRequest(request)) track(request)
    return request
  }
  return {
    lastReceivedAt: () => receivedAt,
    abortAll(reason) {
      const requests = [...open]
      open.clear()
      for (const request of requests) {
        try { request.emit('error', reason) } catch { /* the others still have to go */ }
        try { request.abort() } catch { /* same */ }
      }
      return requests.length
    },
  }
}

export interface ResponseBodyGuard {
  signal: AbortSignal
  // Called after every chunk so a slow but moving download is judged on
  // inactivity, not on its total duration. Throwing from it stops the read.
  onChunk?: () => void
}

export interface BoundedResponseOptions {
  // 超限时的报错。缺省是「…响应超过 N KB 安全上限」；改成流式读取的老代码各有一句客户见过的
  // 「响应过大」，换读取方式时照原样留着。
  oversizeMessage?: string
  // 超限要抛带类型的错误（账号客户端认 RealmAccountError）时用它，设了就不看 oversizeMessage。
  oversizeError?: () => Error
  // 设了就不收空响应：没有响应体、读完是 0 字节各报各的那句。缺省照旧返回空内容。
  requireNonEmpty?: { missingBodyMessage: string; emptyMessage: string }
  // 每读一块都跟 signal 赛跑：响应体不理请求信号时，超时和「停止」也能马上结束读取。
  guard?: ResponseBodyGuard
}

/**
 * Settles with the promise, or rejects with the signal's reason as soon as the
 * signal aborts. A response body that ignores its request signal (a mock, or a
 * stream a proxy keeps open) must still let a timeout or 「停止」 finish the
 * operation instead of hanging whenIdle() and the account switch behind it.
 */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined)
    return Promise.reject(signal.reason)
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      void promise.catch(() => undefined)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then((value) => {
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }, (error: unknown) => {
      signal.removeEventListener('abort', onAbort)
      reject(error)
    })
  })
}

export async function readBoundedResponseText(
  response: Response,
  maximumBytes: number,
  label: string,
  options: BoundedResponseOptions = {},
): Promise<string> {
  return (await readBoundedResponseBytes(response, maximumBytes, label, options)).toString('utf8')
}

export async function readBoundedResponseBytes(
  response: Response,
  maximumBytes: number,
  label: string,
  options: BoundedResponseOptions = {},
): Promise<Buffer> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new Error(`${label}响应读取上限无效`)
  }
  function oversize(): Error {
    return options.oversizeError?.()
      ?? new Error(options.oversizeMessage ?? `${label}响应超过 ${Math.floor(maximumBytes / 1024)} KB 安全上限`)
  }

  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    // 不读也要关掉，不留着一条没人读的连接。
    await response.body?.cancel().catch(() => undefined)
    throw oversize()
  }
  if (!response.body) {
    if (options.requireNonEmpty) throw new Error(options.requireNonEmpty.missingBodyMessage)
    return Buffer.alloc(0)
  }

  const guard = options.guard
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let received = 0
  try {
    while (true) {
      const chunk = guard ? await raceAbort(reader.read(), guard.signal) : await reader.read()
      if (chunk.done) break
      guard?.onChunk?.()
      if (!chunk.value?.byteLength) continue
      received += chunk.value.byteLength
      if (received > maximumBytes) throw oversize()
      chunks.push(Buffer.from(chunk.value))
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
  if (received === 0 && options.requireNonEmpty) throw new Error(options.requireNonEmpty.emptyMessage)
  return Buffer.concat(chunks, received)
}

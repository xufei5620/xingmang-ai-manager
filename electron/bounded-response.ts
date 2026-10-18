export interface BoundedResponseOptions {
  // 超限时的报错。缺省是「…响应超过 N KB 安全上限」；改成流式读取的老代码各有一句客户见过的
  // 「响应过大」，换读取方式时照原样留着。
  oversizeMessage?: string
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
  const oversizeMessage = options.oversizeMessage
    ?? `${label}响应超过 ${Math.floor(maximumBytes / 1024)} KB 安全上限`

  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error(oversizeMessage)
  }
  if (!response.body) return Buffer.alloc(0)

  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let received = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      if (!chunk.value?.byteLength) continue
      received += chunk.value.byteLength
      if (received > maximumBytes) {
        await reader.cancel().catch(() => undefined)
        throw new Error(oversizeMessage)
      }
      chunks.push(Buffer.from(chunk.value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, received)
}

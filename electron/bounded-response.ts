export async function readBoundedResponseText(
  response: Response,
  maximumBytes: number,
  label: string,
): Promise<string> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new Error(`${label}响应读取上限无效`)
  }

  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error(`${label}响应超过 ${Math.floor(maximumBytes / 1024)} KB 安全上限`)
  }
  if (!response.body) return ''

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
        throw new Error(`${label}响应超过 ${Math.floor(maximumBytes / 1024)} KB 安全上限`)
      }
      chunks.push(Buffer.from(chunk.value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, received).toString('utf8')
}

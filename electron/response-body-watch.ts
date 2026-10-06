/**
 * 回了话以后正文读到一半出的错（AI 回复写到一半连接断了、账号请求读正文读到一半超时）：
 * 回应已经交给调用方，这一次没法换条路重发，可这条路靠不靠得住还得有人知道。这里把正文
 * 包一层，读出错的那一下报出来，读的人照样拿到原来那个错误。
 *
 * 回应的其余部分原样保留：状态、头（含 set-cookie，账号客户端靠它续登录），以及 url、
 * redirected、type。调用方靠后面这三样拒绝被重定向到别处的请求（I10），新建的 Response
 * 上它们是空串、false 和 'default'，不照抄就等于把那道检查拆了。
 */
export function watchResponseBody(response: Response, onFailure: (error: unknown) => void): Response {
  // 没有正文的（204、opaqueredirect 这类）没什么可读，也就没什么可报。
  if (!response.body || response.type === 'opaqueredirect') return response
  const reader = response.body.getReader()
  const watched = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await reader.read()
      } catch (error) {
        try { onFailure(error) } catch { /* 报的那一侧出错不影响读的人拿到原来的错误 */ }
        controller.error(error)
        return
      }
      if (chunk.done) controller.close()
      else controller.enqueue(chunk.value)
    },
    // 读的人自己不读了（读够了上限、点了「停止」）不是这条路的毛病，不报。
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
  const wrapped = new Response(watched, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
  Object.defineProperties(wrapped, {
    url: { value: response.url },
    redirected: { value: response.redirected },
    type: { value: response.type },
  })
  return wrapped
}

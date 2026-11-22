import { randomBytes } from 'node:crypto'
import { readBoundedResponseText } from './bounded-response'
import { sanitizeUpstreamDetail } from './command-runner'
import {
  classifyConnectionFailure,
  classifyConnectionResponse,
  extractUpstreamMessage,
  runConnectionProbe,
  type ConnectionProbeBuild,
  type ConnectionProbeDependencies,
  type ConnectionProbeReport,
} from './connection-check'

const toolName = 'xingmang_probe_echo'
const prompt = 'Call xingmang_probe_echo exactly once with no arguments. After receiving its result, reply with exactly the returned string and no other text.'
const maximumOutputTokens = 1024
const maximumResponseBytes = 64 * 1024
const totalTimeoutMs = 45_000
const redirectStatuses = new Set([301, 302, 303, 307, 308])

const probeTool = {
  type: 'function',
  name: toolName,
  description: 'Returns a fixed protocol-check marker. It has no side effects.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
} as const

interface ProbeResponse {
  status: number
  payload: unknown
}

export interface CodexResponsesProbeDependencies extends ConnectionProbeDependencies {
  /** Main-process account/site/config fingerprint, never returned or logged. */
  currentScope?: () => string
  /** Per-run guard captured from currentScope before any await. */
  isCurrent?: () => boolean
  /** Tests use a fixed marker; production creates it only after the first response. */
  markerFactory?: () => string
}

interface FunctionCallProof {
  callId: string
  output: Record<string, unknown>[]
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function isCompletedResponse(value: unknown): value is Record<string, unknown> & { output: unknown[] } {
  const record = asRecord(value)
  return Boolean(
    record
    && record.object === 'response'
    && typeof record.id === 'string'
    && record.id.length > 0
    && record.status === 'completed'
    && Array.isArray(record.output)
    && record.output.length <= 16,
  )
}

/** A tool call is evidence only when its identity, arguments and call id are exact. */
export function inspectCodexResponsesFunctionCall(value: unknown): FunctionCallProof | null {
  if (!isCompletedResponse(value)) return null
  const output: Record<string, unknown>[] = []
  let callId: string | null = null
  for (const item of value.output) {
    const record = asRecord(item)
    if (!record) return null
    if (record.type === 'reasoning') {
      output.push(record)
      continue
    }
    if (
      record.type !== 'function_call'
      || record.name !== toolName
      || ('status' in record && record.status !== 'completed')
      || typeof record.call_id !== 'string'
      || !/^[A-Za-z0-9_-]{1,128}$/.test(record.call_id)
      || typeof record.arguments !== 'string'
      || callId !== null
    ) return null
    let args: unknown
    try { args = JSON.parse(record.arguments) } catch { return null }
    const parsed = asRecord(args)
    if (!parsed || Object.keys(parsed).length !== 0) return null
    callId = record.call_id
    output.push(record)
  }
  return callId ? { callId, output } : null
}

/** The second request must consume the fixed tool result and produce the exact marker. */
export function inspectCodexResponsesFinalAnswer(value: unknown, expectedText: string): boolean {
  if (!isCompletedResponse(value)) return false
  let text = ''
  let messages = 0
  for (const item of value.output) {
    const record = asRecord(item)
    if (!record) return false
    if (record.type === 'reasoning') continue
    if (record.type !== 'message' || record.role !== 'assistant' || !Array.isArray(record.content)) return false
    if ('status' in record && record.status !== 'completed') return false
    messages += 1
    for (const part of record.content) {
      const content = asRecord(part)
      if (!content || content.type !== 'output_text' || typeof content.text !== 'string') return false
      text += content.text
    }
  }
  return messages === 1 && text.trim() === expectedText
}

export function buildCodexResponsesRequest(
  model: string,
  previous?: FunctionCallProof,
  resultMarker?: string,
): Record<string, unknown> {
  const input: unknown[] = [{ role: 'user', content: prompt }]
  if (previous) {
    if (!resultMarker || !/^XINGMANG_[a-f0-9]{24}$/.test(resultMarker)) {
      throw new Error('检查用的标记无效')
    }
    input.push(...previous.output, {
      type: 'function_call_output',
      call_id: previous.callId,
      output: resultMarker,
    })
  }
  return {
    model,
    store: false,
    stream: false,
    max_output_tokens: maximumOutputTokens,
    parallel_tool_calls: false,
    tools: [probeTool],
    tool_choice: previous ? 'none' : { type: 'function', name: toolName },
    input,
  }
}

function responsesUrlFromCatalog(url: string): URL | null {
  let parsed: URL
  try { parsed = new URL(url) } catch { return null }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) return null
  if (!parsed.pathname.endsWith('/models')) return null
  parsed.pathname = parsed.pathname.slice(0, -'/models'.length) + '/responses'
  return parsed
}

/**
 * Only the explicitly clicked probe reaches this function. It uses the
 * already checked Codex config plan, never a URL or Key supplied by renderer.
 * Both requests share one timeout and each response has a strict byte cap.
 */
export async function runCodexResponsesProbe(
  build: ConnectionProbeBuild,
  dependencies: CodexResponsesProbeDependencies = {},
): Promise<ConnectionProbeReport> {
  if (build.kind === 'blocked') return runConnectionProbe(build, dependencies)
  const plan = build.plan
  const now = dependencies.now ?? (() => new Date())
  const elapsed = dependencies.elapsed ?? (() => Date.now())
  const startedAt = elapsed()
  const url = plan.protocol === 'openai-models' ? responsesUrlFromCatalog(plan.url) : null

  function finish(
    layer: ConnectionProbeReport['layer'],
    summary: string,
    nextStep: string,
    status: number | null = null,
    detail: string | null = null,
    ok = false,
  ): ConnectionProbeReport {
    return {
      ok,
      layer,
      summary,
      nextStep,
      ...(ok ? { verificationLevel: 'responses-tool-json' as const } : {}),
      evidence: ok
        ? `${plan.model} 已调用一次不做任何修改的测试工具，并正确读取了结果；Codex 中的实际工作情况仍以实际使用为准`
        : undefined,
      endpoint: url?.href ?? null,
      model: plan.model,
      detail,
      status,
      durationMs: Math.max(0, elapsed() - startedAt),
      checkedAt: now().toISOString(),
    }
  }

  if (!url || url.origin !== plan.origin) {
    return finish('config', '未找到 Codex 应连接的服务地址', '请在首页重新准备 Codex 后重试')
  }
  if (dependencies.isCurrent?.() === false) {
    return finish('config', '当前账号或 Codex 设置已变化，检查已停止', '请确认当前账号后重新勾选检查')
  }
  const fetchImpl = dependencies.fetch ?? globalThis.fetch
  if (!fetchImpl) return finish('unknown', '本次无法检查', '请重新打开本软件后重试')
  const endpoint = url.href

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), dependencies.timeoutMs ?? totalTimeoutMs)
  timeout.unref?.()

  async function request(body: Record<string, unknown>): Promise<ProbeResponse | ConnectionProbeReport> {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { ...plan.headers, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      credentials: 'omit',
      redirect: 'manual',
      signal: controller.signal,
    })
    if (response.url) {
      let responseOrigin: string | null = null
      try { responseOrigin = new URL(response.url).origin } catch { /* Invalid URL is rejected below. */ }
      if (responseOrigin !== plan.origin) {
        return finish('protocol', '服务将请求转至其他地址，已拒绝', '请在首页重新准备 Codex 后重试', response.status)
      }
    }
    if (redirectStatuses.has(response.status)) {
      return finish('protocol', '服务要求转至其他地址，检查已停止', '请稍后重试；如持续出现，请联系客服', response.status)
    }
    let bodyText: string
    try {
      bodyText = await readBoundedResponseText(
        response,
        dependencies.maxResponseBytes ?? maximumResponseBytes,
        'Codex 干活检查',
      )
    } catch {
      return finish('protocol', '服务返回的内容过大或无法读取', '请稍后重试；如持续出现，请联系客服', response.status)
    }
    let payload: unknown = null
    try { payload = JSON.parse(bodyText) } catch { /* Malformed JSON fails below. */ }
    if (response.status < 200 || response.status >= 300) {
      const message = extractUpstreamMessage(payload)
      const outcome = classifyConnectionResponse(
        { name: plan.name, protocol: plan.protocol, model: plan.model },
        response.status,
        message,
        payload,
        { headers: response.headers, bodyText },
      )
      return finish(
        outcome.layer,
        outcome.summary,
        outcome.nextStep,
        response.status,
        sanitizeUpstreamDetail(message, [plan.apiKey]) || null,
      )
    }
    return { status: response.status, payload }
  }

  try {
    const first = await request(buildCodexResponsesRequest(plan.model))
    if ('ok' in first) return first
    if (asRecord(first.payload)?.status === 'incomplete') {
      return finish('protocol', '模型未完成回答即已停止', '这并不表示账号有问题，请更换模型或稍后重试', first.status)
    }
    const call = inspectCodexResponsesFunctionCall(first.payload)
    if (!call) {
      return finish('protocol', '模型未按要求调用测试工具', '该模型可能无法使用工具，Codex 工作时也可能出错；请更换模型后重试，或联系客服', first.status)
    }
    if (dependencies.isCurrent?.() === false) {
      return finish('config', '当前账号或 Codex 设置已变化，未发送第二次请求', '请确认当前账号后重新勾选检查', first.status)
    }
    const resultMarker = dependencies.markerFactory?.() ?? `XINGMANG_${randomBytes(12).toString('hex')}`
    const second = await request(buildCodexResponsesRequest(plan.model, call, resultMarker))
    if ('ok' in second) return second
    if (asRecord(second.payload)?.status === 'incomplete') {
      return finish('protocol', '模型未完成回答即已停止', '这并不表示账号有问题，请更换模型或稍后重试', second.status)
    }
    if (!inspectCodexResponsesFinalAnswer(second.payload, resultMarker)) {
      return finish('protocol', '模型未能读取测试工具的结果', '请稍后重试；如持续出现，请联系客服', second.status)
    }
    if (dependencies.isCurrent?.() === false) {
      return finish('config', '当前账号或 Codex 设置已变化，本次结果无效', '请确认当前账号后重新勾选检查', second.status)
    }
    return finish(
      'network',
      `${plan.model} 能正常调用工具`,
      '无需处理',
      second.status,
      null,
      true,
    )
  } catch (error) {
    const outcome = classifyConnectionFailure(error)
    const detail = sanitizeUpstreamDetail(error instanceof Error ? error.message : '', [plan.apiKey]) || null
    return finish(outcome.layer, outcome.summary, outcome.nextStep, null, detail)
  } finally {
    controller.abort()
    clearTimeout(timeout)
  }
}

/** Multiple clicks in flight share the same paid two-request operation. */
export function createCodexResponsesProbeService(
  build: () => ConnectionProbeBuild,
  dependencies: CodexResponsesProbeDependencies,
): { run(): Promise<ConnectionProbeReport> } {
  let inFlight: Promise<ConnectionProbeReport> | null = null
  let inFlightScope: string | null = null
  function run(): Promise<ConnectionProbeReport> {
    const scope = dependencies.currentScope?.() ?? ''
    if (inFlight) {
      return inFlightScope === scope
        ? inFlight
        : Promise.reject(new Error('当前账号或 Codex 设置已变化，请待上一次检查结束后重试'))
    }
    const current = runCodexResponsesProbe(build(), {
      ...dependencies,
      isCurrent: () => {
        try { return (dependencies.currentScope?.() ?? '') === scope } catch { return false }
      },
    })
    inFlight = current
    inFlightScope = scope
    void current.finally(() => {
      if (inFlight === current) {
        inFlight = null
        inFlightScope = null
      }
    }).catch(() => undefined)
    return current
  }
  return { run }
}

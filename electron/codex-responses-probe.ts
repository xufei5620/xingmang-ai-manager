import { randomBytes } from 'node:crypto'
import { readBoundedResponseText } from './bounded-response'
import {
  classifyConnectionFailure,
  classifyConnectionResponse,
  extractUpstreamMessage,
  runConnectionProbe,
  sanitizeUpstreamDetail,
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
      throw new Error('Responses 验证标记无效')
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
        ? '已验证星芒中转的 Responses JSON 双请求与虚拟工具结果回传；未验证流式、原生桌面进程、搜索、生图或电脑操作'
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
    return finish('config', '无法确认 Codex Responses 的星芒服务地址', '在首页重新写入一次 Codex 配置后再试')
  }
  if (dependencies.isCurrent?.() === false) {
    return finish('config', '账号或 Codex 配置已变化，验证已停止', '请确认当前账号与配置后重新发起')
  }
  const fetchImpl = dependencies.fetch ?? globalThis.fetch
  if (!fetchImpl) return finish('unknown', '当前运行时不支持连接验证', '请重启客户端后再试')
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
        return finish('protocol', 'Responses 请求跳转到了其他服务，已拒绝', '请重新写入 Codex 配置后再试', response.status)
      }
    }
    if (redirectStatuses.has(response.status)) {
      return finish('protocol', 'Responses 服务要求跳转，已拒绝继续请求', '请稍后再试，持续出现时联系支持', response.status)
    }
    let bodyText: string
    try {
      bodyText = await readBoundedResponseText(
        response,
        dependencies.maxResponseBytes ?? maximumResponseBytes,
        'Codex Responses 验证',
      )
    } catch {
      return finish('protocol', 'Responses 返回内容过大或无法读取', '请稍后再试，持续出现时联系支持', response.status)
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
      return finish('protocol', 'Responses 首次请求未完成，可能达到输出上限', '这不表示密钥失效；请换模型或稍后重试', first.status)
    }
    const call = inspectCodexResponsesFunctionCall(first.payload)
    if (!call) {
      return finish('protocol', 'Responses 未返回约定的虚拟工具调用', '模型可能不支持此协议或中转尚未接通工具调用', first.status)
    }
    if (dependencies.isCurrent?.() === false) {
      return finish('config', '账号或 Codex 配置已变化，已停止第二次付费请求', '请确认当前账号与配置后重新发起', first.status)
    }
    const resultMarker = dependencies.markerFactory?.() ?? `XINGMANG_${randomBytes(12).toString('hex')}`
    const second = await request(buildCodexResponsesRequest(plan.model, call, resultMarker))
    if ('ok' in second) return second
    if (asRecord(second.payload)?.status === 'incomplete') {
      return finish('protocol', 'Responses 第二次请求未完成，可能达到输出上限', '这不表示密钥失效；请换模型或稍后重试', second.status)
    }
    if (!inspectCodexResponsesFinalAnswer(second.payload, resultMarker)) {
      return finish('protocol', 'Responses 未确认工具结果回传', '中转的工具结果回传可能未完成，请稍后再试', second.status)
    }
    if (dependencies.isCurrent?.() === false) {
      return finish('config', '账号或 Codex 配置已变化，旧结果已丢弃', '请确认当前账号与配置后重新发起', second.status)
    }
    return finish(
      'network',
      'Responses 虚拟工具往返已验证',
      '基础协议已验证；请在原生客户端内确认实际使用体验',
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
        : Promise.reject(new Error('账号或 Codex 配置已变化，请等上次验证结束后再试'))
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

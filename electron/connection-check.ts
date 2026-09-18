import { cliCatalog, type ProviderId } from './catalog'
import { defaultCliModels } from './cli-model-defaults'
import { redactCommandText } from './command-runner'
import { readBoundedResponseText } from './bounded-response'
import type { NativeConfigInspection } from './config-files'
import type { RelaySite } from './relay-sites'

/**
 * Which layer of the "装好了但一跑就报错" stack the probe stopped at. The
 * HEAD probe in diagnostics.ts (XINGMANG_NETWORK) only ever answers the
 * `network` question, which is why a user whose key was revoked still sees
 * 「已连通」 and ends up in a support ticket. Every other member here is a
 * failure that check cannot see.
 */
export type ConnectionCheckLayer =
  | 'config'
  | 'network'
  | 'credential'
  | 'quota'
  | 'group'
  | 'model'
  | 'protocol'
  | 'unknown'

export const connectionCheckLayerLabels: Readonly<Record<ConnectionCheckLayer, string>> = {
  config: '本地配置',
  network: '网络',
  credential: '密钥',
  quota: '额度',
  group: '分组与渠道',
  model: '模型',
  protocol: '协议与端点',
  unknown: '未知',
}

/**
 * Renderer-facing outcome. Deliberately carries no API key and no raw
 * upstream body: `detail` is redacted, control-stripped and truncated the
 * same way new-api-client.ts treats upstream copy (I3/I13).
 */
export interface ConnectionCheckResult {
  provider: ProviderId
  /**
   * 当前 realm 的站点 id。**只给日志和客服排查用**：站点切换对用户是无感的
   * (老板拍板)，所以界面文案里永远不出现站点名。
   */
  siteId: string
  ok: boolean
  layer: ConnectionCheckLayer
  /** 一句话结论，直接上屏。 */
  summary: string
  /** 用户下一步该做什么。 */
  nextStep: string
  /** 探测打到的地址，便于客服核对；永不含 Key。 */
  endpoint: string | null
  /** 探测用的模型名，来自该工具配置文件里真正写着的那个。 */
  model: string | null
  /** 上游返回的原文，已脱敏截断；没有可展示内容时为 null。 */
  detail: string | null
  status: number | null
  durationMs: number
  checkedAt: string
}

/** 主进程内部的探测计划。含 Key，永不跨 IPC。 */
export interface ConnectionProbePlan {
  provider: ProviderId
  siteId: string
  /** 该 CLI 真正说的那门协议。今天只有 Claude Code 一门，其余留扩展点。 */
  protocol: 'anthropic-messages'
  url: string
  origin: string
  headers: Record<string, string>
  body: Record<string, unknown>
  model: string
  apiKey: string
}

interface LayerOutcome {
  layer: ConnectionCheckLayer
  summary: string
  nextStep: string
}

export type ConnectionProbeBuild =
  | { kind: 'probe'; plan: ConnectionProbePlan }
  | { kind: 'blocked'; outcome: LayerOutcome; model: string | null }

export interface ConnectionCheckDependencies {
  provider: ProviderId
  /**
   * The site the user is actually on. Its providerBaseUrls is what
   * inspectProviderConfig reconciled `matchesRelay` against, so the probe and
   * the diagnosis must read the same site or a sub2api user would be told
   * their working config points "somewhere else".
   */
  site: RelaySite
  inspection: NativeConfigInspection
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
  maxResponseBytes?: number
  now?: () => Date
  /** Monotonic clock for durationMs; injectable so tests do not depend on wall time. */
  elapsed?: () => number
}

const defaultTimeoutMs = 20_000
const defaultMaxResponseBytes = 64 * 1024
const redirectStatuses = new Set([301, 302, 303, 307, 308])
const controlCharacterPattern = new RegExp(
  '[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + String.fromCharCode(127) + ']',
  'g',
)

/**
 * Providers whose wire protocol the probe knows how to speak. Codex, Gemini
 * and Grok each need their own request shape (and Codex additionally needs
 * the responses/chat-completions choice resolved), so they stay out until
 * that shape is written and tested rather than being probed with a request
 * they would reject for the wrong reason.
 */
export function connectionCheckSupported(provider: ProviderId): boolean {
  return provider === 'claude'
}

export function connectionCheckUnsupportedMessage(provider: ProviderId): string {
  return `${cliCatalog[provider].name} 的连接自检还在开发中，目前只支持 ${cliCatalog.claude.name}`
}

function joinRelayPath(baseUrl: string, relativePath: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${relativePath}`
}

/**
 * https only, no embedded credentials -- same rule new-api-client.ts applies
 * to the account origin. The base URL comes out of a config file on disk,
 * which a local attacker can edit, so it is validated rather than trusted.
 */
function validateProbeUrl(value: string): URL {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('配置里的服务地址格式无效')
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
    throw new Error('配置里的服务地址必须是不含凭据的 https 地址')
  }
  return parsed
}

function blocked(outcome: LayerOutcome, model: string | null = null): ConnectionProbeBuild {
  return { kind: 'blocked', outcome, model }
}

/**
 * Turns "what this CLI's config file actually says" into a probe, or into the
 * config-layer answer that makes a request pointless. Pure: every input is a
 * plain value, so each blocked branch is one assertion in the test file.
 */
export function buildConnectionProbe(
  provider: ProviderId,
  site: RelaySite,
  inspection: NativeConfigInspection,
): ConnectionProbeBuild {
  const name = cliCatalog[provider].name
  if (!connectionCheckSupported(provider)) {
    return blocked({
      layer: 'config',
      summary: connectionCheckUnsupportedMessage(provider),
      nextStep: `请先用${cliCatalog.claude.name}自检确认账号和网络，其余工具的自检稍后开放`,
    })
  }
  if (!inspection.exists) {
    return blocked({
      layer: 'config',
      summary: `还没有找到 ${name} 的配置文件`,
      nextStep: '先在首页给这个工具写入星芒 Key，再回来自检',
    })
  }
  if (!inspection.hasApiKey) {
    return blocked({
      layer: 'config',
      summary: `${name} 的配置里没有 API Key`,
      nextStep: '先在首页登录星芒账号并写入 Key，再回来自检',
    })
  }
  if (!inspection.actualBaseUrl) {
    return blocked({
      layer: 'config',
      summary: `${name} 的配置里没有服务地址`,
      nextStep: '在首页重新写入一次配置，让工具重新指向星芒服务',
    })
  }
  // matchesRelay 是拿 inspection.baseUrl 对账出来的，而 baseUrl 来自调用方
  // 传给 inspectProviderConfig 的那个站点。两者不是同一个站点时，
  // matchesRelay 为真也只说明"配置指向了另一个站点"，照发就会把付费 Key
  // 送到一个本次没有核对过的主机。今天唯一的调用点两边同源，这条断言是
  // 把那份耦合从注释变成代码。
  if (inspection.baseUrl !== site.providerBaseUrls[provider]) {
    return blocked({
      layer: 'config',
      summary: `${name} 的配置与当前账号不是同一套，已取消自检`,
      nextStep: '在首页重新写入一次星芒 Key，再回来自检',
    })
  }
  if (!inspection.matchesRelay) {
    // 不回显 actualBaseUrl：它可能正是另一个星芒站点的域名，而站点切换对
    // 用户是无感的，说出来只会制造困惑。
    return blocked({
      layer: 'config',
      summary: `${name} 当前的配置没有指向星芒服务`,
      nextStep: '自检只会向星芒服务发请求。请先在首页把这个工具重新写入一次星芒 Key',
    })
  }
  const model = inspection.model || defaultCliModels[provider]
  let url: URL
  try {
    url = validateProbeUrl(joinRelayPath(inspection.actualBaseUrl, 'v1/messages'))
  } catch (error) {
    return blocked({
      layer: 'config',
      summary: error instanceof Error ? error.message : '配置里的服务地址无法使用',
      nextStep: '在首页重新写入一次配置，让工具重新指向星芒服务',
    }, model)
  }
  return {
    kind: 'probe',
    plan: {
      provider,
      siteId: site.id,
      protocol: 'anthropic-messages',
      url: url.href,
      origin: url.origin,
      headers: {
        'x-api-key': inspection.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        accept: 'application/json',
      },
      // The cheapest request the Messages API accepts: one token out. The
      // point is to exercise key -> group -> model -> protocol, not to get a
      // useful answer back.
      body: {
        model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      },
      model,
      apiKey: inspection.apiKey,
    },
  }
}

export function sanitizeUpstreamDetail(value: string, secrets: readonly string[]): string {
  if (!value) return ''
  return redactCommandText(value, secrets)
    .replace(controlCharacterPattern, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
}

function includesAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((needle) => haystack.includes(needle))
}

// Upstream copy is new-api's, not ours, and it is localized. Matching on
// both the Chinese and English wording keeps the attribution right whichever
// locale the instance is serving.
const quotaHints = ['额度', '余额', '配额', '欠费', 'quota', 'insufficient', 'balance', 'credit']
const groupHints = ['无可用渠道', '无可用的渠道', '当前分组', '分组', '渠道', 'no available channel', 'no channel', 'group']
const modelHints = ['模型', 'model']
const credentialHints = ['令牌', '密钥', '无效', '禁用', '封禁', 'token', 'api key', 'api_key', 'unauthorized', 'authentication', 'invalid']

/** Extracts the human-readable message from either an OpenAI/new-api or an Anthropic error envelope. */
export function extractUpstreamMessage(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return ''
  const record = payload as Record<string, unknown>
  const error = record.error
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const message = (error as Record<string, unknown>).message
    if (typeof message === 'string') return message
  }
  if (typeof record.message === 'string') return record.message
  if (typeof error === 'string') return error
  return ''
}

/**
 * Maps one upstream reply onto the layer that actually failed. Message text
 * is consulted before status where new-api overloads a status (403 is both
 * "key disabled" and "out of quota"; 404 is both "model gone" and "wrong
 * endpoint"), because the status alone would send the user to the wrong page.
 */
export function classifyConnectionResponse(
  provider: ProviderId,
  status: number,
  message: string,
  payload: unknown,
  model: string,
): LayerOutcome & { ok: boolean } {
  const name = cliCatalog[provider].name
  const lowered = message.toLowerCase()
  const hasQuotaHint = includesAny(lowered, quotaHints)
  const hasGroupHint = includesAny(lowered, groupHints)
  const hasModelHint = includesAny(lowered, modelHints)
  const hasCredentialHint = includesAny(lowered, credentialHints)

  if (status >= 200 && status < 300 && !message) {
    if (!looksLikeMessagesResponse(payload)) {
      return {
        ok: false,
        layer: 'protocol',
        summary: `服务返回了 HTTP ${status}，但内容不是 ${name} 能识别的 API 响应`,
        nextStep: '多半是服务地址指到了网页而不是 API。在首页重新写入一次配置后再试',
      }
    }
    return {
      ok: true,
      layer: 'network',
      summary: `连接正常，${model} 可以直接使用`,
      nextStep: '无需处理',
    }
  }
  if (status === 401) {
    return {
      ok: false,
      layer: 'credential',
      summary: '密钥被拒绝（HTTP 401），可能已被吊销或属于别的账号',
      nextStep: '到「账号」页重新登录，然后在首页重新写入一次 Key',
    }
  }
  if (status === 403) {
    if (hasQuotaHint) return outOfQuota(status)
    return {
      ok: false,
      layer: 'credential',
      summary: `密钥被拒绝（HTTP ${status}），可能已被禁用`,
      nextStep: '到「账号」页查看这个工具的 Key 是否仍然有效，必要时重新写入',
    }
  }
  if (status === 402) return outOfQuota(status)
  if (status === 429) {
    return {
      ok: false,
      layer: 'quota',
      summary: `请求过于频繁或已达用量上限（HTTP ${status}）`,
      nextStep: '稍等片刻再试；若一直如此，请到「账号」页查看余额和用量',
    }
  }
  if (status === 503 || (hasGroupHint && !hasModelHint)) {
    return {
      ok: false,
      layer: 'group',
      summary: `当前账号分组下没有可用渠道（HTTP ${status}）`,
      nextStep: '到「账号」页确认这个工具对应的套餐仍在有效期内，再点一次「写入 Key」让客户端重新签发',
    }
  }
  if (hasModelHint) {
    return {
      ok: false,
      layer: 'model',
      summary: `星芒服务不认识模型 ${model}（HTTP ${status}）`,
      nextStep: '在首页把这个工具的模型改成列表里仍然可用的一个，再自检一次',
    }
  }
  if (hasQuotaHint) return outOfQuota(status)
  if (hasCredentialHint) {
    return {
      ok: false,
      layer: 'credential',
      summary: `密钥被拒绝（HTTP ${status}）`,
      nextStep: '到「账号」页重新登录，然后在首页重新写入一次 Key',
    }
  }
  if (status === 404 || status === 405) {
    return {
      ok: false,
      layer: 'protocol',
      summary: `星芒服务上没有这个接口（HTTP ${status}）`,
      nextStep: '在首页重新写入一次配置，让服务地址回到星芒服务的标准地址',
    }
  }
  if (status >= 500) {
    return {
      ok: false,
      layer: 'unknown',
      summary: `星芒服务暂时异常（HTTP ${status}）`,
      nextStep: '稍后再试一次；若持续出现请把这条结果发给客服',
    }
  }
  return {
    ok: false,
    layer: 'protocol',
    summary: `星芒服务拒绝了这次最小请求（HTTP ${status}）`,
    nextStep: '把下面的原文发给客服，可以直接定位问题',
  }
}

function outOfQuota(status: number): LayerOutcome & { ok: boolean } {
  return {
    ok: false,
    layer: 'quota',
    summary: `账号额度不足（HTTP ${status}）`,
    nextStep: '到「账号」页查看余额，充值后即可继续使用',
  }
}

function looksLikeMessagesResponse(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false
  const record = payload as Record<string, unknown>
  return record.type === 'message' || Array.isArray(record.content) || typeof record.stop_reason === 'string'
}

/**
 * Nothing came back at all: DNS, TLS, proxy or timeout. This is the one layer
 * the existing HEAD check already covered, kept here so a user who runs the
 * self-check first still gets a complete answer.
 */
export function classifyConnectionFailure(error: unknown): LayerOutcome & { ok: boolean } {
  if (error instanceof Error && error.name === 'AbortError') {
    return {
      ok: false,
      layer: 'network',
      summary: '请求超时，没有收到星芒服务的回应',
      nextStep: '检查网络或代理；若开着 Clash 的 TUN 模式，先关掉再试',
    }
  }
  return {
    ok: false,
    layer: 'network',
    summary: '连不上星芒服务',
    nextStep: '检查网络或代理设置；公司网络和部分校园网会拦截这个域名',
  }
}

/**
 * Sends one minimal real request with the key the CLI actually uses and
 * reports which layer answered. I10: timeout, response byte cap, manual
 * redirect handling with an outright rejection, and an https/origin check --
 * this request carries a paid API key, so a redirect must never be followed.
 */
export async function runConnectionCheck(
  dependencies: ConnectionCheckDependencies,
): Promise<ConnectionCheckResult> {
  const { provider, site, inspection } = dependencies
  const now = dependencies.now ?? (() => new Date())
  const elapsed = dependencies.elapsed ?? (() => Date.now())
  const startedAt = elapsed()
  const finish = (
    outcome: LayerOutcome & { ok?: boolean },
    extras: { endpoint?: string | null; model?: string | null; detail?: string | null; status?: number | null },
  ): ConnectionCheckResult => ({
    provider,
    siteId: site.id,
    ok: outcome.ok ?? false,
    layer: outcome.layer,
    summary: outcome.summary,
    nextStep: outcome.nextStep,
    endpoint: extras.endpoint ?? null,
    model: extras.model ?? null,
    detail: extras.detail ?? null,
    status: extras.status ?? null,
    durationMs: Math.max(0, elapsed() - startedAt),
    checkedAt: now().toISOString(),
  })

  const build = buildConnectionProbe(provider, site, inspection)
  if (build.kind === 'blocked') return finish(build.outcome, { model: build.model })

  const plan = build.plan
  const fetchImpl = dependencies.fetch ?? globalThis.fetch
  if (!fetchImpl) {
    return finish({
      layer: 'unknown',
      summary: '当前运行时不支持 fetch，无法自检',
      nextStep: '请重启客户端后再试',
    }, { endpoint: plan.url, model: plan.model })
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), dependencies.timeoutMs ?? defaultTimeoutMs)
  timeout.unref?.()
  try {
    const response = await fetchImpl(plan.url, {
      method: 'POST',
      headers: plan.headers,
      body: JSON.stringify(plan.body),
      credentials: 'omit',
      redirect: 'manual',
      signal: controller.signal,
    })
    if (response.url) {
      let responseOrigin: string | null = null
      try {
        responseOrigin = new URL(response.url).origin
      } catch {
        responseOrigin = null
      }
      if (responseOrigin !== plan.origin) {
        return finish({
          ok: false,
          layer: 'protocol',
          summary: '请求被重定向到了别的地址，已拒绝',
          nextStep: '在首页重新写入一次配置；若仍然如此，请把这条结果发给客服',
        }, { endpoint: plan.url, model: plan.model, status: response.status })
      }
    }
    if (redirectStatuses.has(response.status)) {
      return finish({
        ok: false,
        layer: 'protocol',
        summary: `星芒服务要求跳转到别的地址（HTTP ${response.status}），已拒绝`,
        nextStep: '在首页重新写入一次配置；若仍然如此，请把这条结果发给客服',
      }, { endpoint: plan.url, model: plan.model, status: response.status })
    }
    let bodyText: string
    try {
      bodyText = await readBoundedResponseText(
        response,
        dependencies.maxResponseBytes ?? defaultMaxResponseBytes,
        '连接自检',
      )
    } catch (error) {
      // An oversized or truncated body is not a network failure: the service
      // answered, it just did not answer like an API. Classifying it as
      // 'network' would send the user off to check their proxy for nothing.
      return finish({
        ok: false,
        layer: 'protocol',
        summary: `星芒服务返回的内容无法读取（HTTP ${response.status}）`,
        nextStep: '在首页重新写入一次配置；若仍然如此，请把这条结果发给客服',
      }, {
        endpoint: plan.url,
        model: plan.model,
        status: response.status,
        detail: sanitizeUpstreamDetail(error instanceof Error ? error.message : '', [plan.apiKey]) || null,
      })
    }
    let payload: unknown = null
    if (bodyText) {
      try {
        payload = JSON.parse(bodyText)
      } catch {
        payload = null
      }
    }
    const message = extractUpstreamMessage(payload)
    const outcome = classifyConnectionResponse(provider, response.status, message, payload, plan.model)
    const detail = sanitizeUpstreamDetail(message || (payload === null ? bodyText : ''), [plan.apiKey])
    return finish(outcome, {
      endpoint: plan.url,
      model: plan.model,
      status: response.status,
      detail: outcome.ok ? null : detail || null,
    })
  } catch (error) {
    // Byte-cap and JSON guards throw with our own Chinese copy; a genuine
    // transport failure throws the runtime's. Both land here, and neither is
    // swallowed -- the message travels to the user as `detail`.
    const outcome = classifyConnectionFailure(error)
    const raw = error instanceof Error ? error.message : String(error ?? '')
    return finish(outcome, {
      endpoint: plan.url,
      model: plan.model,
      detail: sanitizeUpstreamDetail(raw, [plan.apiKey]) || null,
    })
  } finally {
    clearTimeout(timeout)
  }
}

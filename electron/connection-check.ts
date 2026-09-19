import { cliCatalog, type ProviderId } from './catalog'
import { defaultCliModels } from './cli-model-defaults'
import { redactCommandText } from './command-runner'
import { readBoundedResponseText } from './bounded-response'
import { geminiCliCompatibleModel, type NativeConfigInspection } from './config-files'
import { parseModelIds } from './models'
import type { RelaySite } from './relay-sites'

/**
 * Which layer of the "装好了但一跑就报错" stack the probe stopped at. The
 * HEAD probe in diagnostics.ts (XINGMANG_NETWORK) only ever answers the
 * `network` question, which is why a user whose key was revoked still sees
 * 「已连通」 and ends up in a support ticket. Every other member here is a
 * failure that check cannot see.
 *
 * `unconfigured` is deliberately separate from `config`: a tool the user has
 * simply not set up yet is not a fault, and showing it as one next to three
 * working tools reads as "三个坏了" (功能 N2 扩展). `config` stays for a
 * config file that exists and is wrong.
 */
export type ConnectionCheckLayer =
  | 'unconfigured'
  | 'config'
  | 'network'
  | 'credential'
  | 'quota'
  | 'group'
  | 'model'
  | 'protocol'
  | 'unknown'

export const connectionCheckLayerLabels: Readonly<Record<ConnectionCheckLayer, string>> = {
  unconfigured: '未配置',
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
 * The wire shape a probe speaks.
 *
 * `anthropic-messages` is Claude Code's: one `max_tokens: 1` generation,
 * unchanged since #143 so that tool's behaviour is exactly what it was.
 *
 * `openai-models` is the read-only model catalogue the relay exposes at
 * `/v1/models`, and it is what the other three CLIs are probed with. It
 * costs nothing on the account (no generation is billed), and because the
 * relay filters that list by the token's group it answers key -> group ->
 * model in one request, which a generation only answers by spending tokens.
 *
 * Why Gemini is probed here rather than through its own `/v1beta` shape:
 * the only relay endpoint whose behaviour this repository has actually
 * verified for listing is `/v1/models` (system-service.ts fetches it to
 * populate the model picker). A relay token is protocol-agnostic -- the
 * same token authorizes both shapes -- so the catalogue answers the same
 * questions, whereas guessing at `/v1beta/models` risks a 404 that would be
 * reported to the user as 「服务上没有这个接口」 when the endpoint simply
 * is not implemented. Do not switch it over on the strength of the upstream
 * Google API alone (CLAUDE.md T12: endpoint facts come from measurement).
 */
export type ConnectionProbeProtocol = 'anthropic-messages' | 'openai-models'

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
  /**
   * 这次自检到底做了什么，一句中文。四个工具的探测形态不同（生成一次 vs
   * 核对模型清单），结论页要如实说出来，而不是让渲染层照 provider 猜。
   */
  evidence?: string
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
  protocol: ConnectionProbeProtocol
  method: 'GET' | 'POST'
  url: string
  origin: string
  headers: Record<string, string>
  /** GET 探测没有请求体。 */
  body: Record<string, unknown> | null
  /** 该工具启动时真正会发给服务的模型名。 */
  model: string
  apiKey: string
}

/** classifyConnectionResponse 需要知道的探测身份，不含 Key。 */
export type ConnectionProbeIdentity = Pick<ConnectionProbePlan, 'provider' | 'protocol' | 'model'>

interface LayerOutcome {
  layer: ConnectionCheckLayer
  summary: string
  nextStep: string
  evidence?: string
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

interface ProbeShape {
  protocol: ConnectionProbeProtocol
  method: 'GET' | 'POST'
  /** 相对该工具配置里那个 base URL 的路径。 */
  path: string
  headers: (apiKey: string) => Record<string, string>
  body: (model: string) => Record<string, unknown> | null
}

/**
 * 只读的模型清单探测。Codex 与 Grok 的 base URL 自带 `/v1` 后缀、Gemini 的
 * 是裸域（catalog.ts 老板拍板 2026-08-12），所以路径由调用方给全，不在这里
 * 猜后缀。
 */
function modelCatalogShape(path: string): ProbeShape {
  return {
    protocol: 'openai-models',
    method: 'GET',
    path,
    headers: (apiKey) => ({
      authorization: `Bearer ${apiKey}`,
      accept: 'application/json',
    }),
    body: () => null,
  }
}

/**
 * 每个 CLI 的探测形态。**无 default 分支 + 非 void 返回类型 = 穷尽性保障**
 * （CLAUDE.md T2）：加第五个 CLI 时漏在这里是编译错，不是运行期静默套用别
 * 家的请求形状去撞一个错的结论。
 */
function probeShape(provider: ProviderId): ProbeShape {
  switch (provider) {
    case 'claude':
      return {
        protocol: 'anthropic-messages',
        method: 'POST',
        path: 'v1/messages',
        headers: (apiKey) => ({
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          accept: 'application/json',
        }),
        // The cheapest request the Messages API accepts: one token out. The
        // point is to exercise key -> group -> model -> protocol, not to get a
        // useful answer back.
        body: (model) => ({
          model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      }
    case 'codex':
      return modelCatalogShape('models')
    case 'grok':
      return modelCatalogShape('models')
    case 'gemini':
      return modelCatalogShape('v1/models')
  }
}

/**
 * 该工具启动时真正发给服务的模型名。Gemini CLI 0.59 会把 `-flash` 结尾的名字
 * 重写成内置别名，写配置时已按 geminiCliCompatibleModel 绕开；自检要核对的是
 * CLI 真正会用的那一个，否则用户改了档位却被告知「模型可用」。
 */
function wireModel(provider: ProviderId, model: string): string {
  return provider === 'gemini' ? geminiCliCompatibleModel(model) : model
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
 * answer that makes a request pointless. Pure: every input is a plain value,
 * so each blocked branch is one assertion in the test file.
 */
export function buildConnectionProbe(
  provider: ProviderId,
  site: RelaySite,
  inspection: NativeConfigInspection,
): ConnectionProbeBuild {
  const name = cliCatalog[provider].name
  // 「还没装/还没配」不是故障：结果页把它显示成未配置，不计进失败里。
  if (!inspection.exists) {
    return blocked({
      layer: 'unconfigured',
      summary: `还没有给 ${name} 写入星芒配置`,
      nextStep: '在首页给这个工具写入星芒 Key，写完再回来自检',
    })
  }
  if (!inspection.hasApiKey) {
    return blocked({
      layer: 'unconfigured',
      summary: `${name} 的配置里还没有 API Key`,
      nextStep: '先在首页登录星芒账号并写入 Key，再回来自检',
    })
  }
  if (!inspection.actualBaseUrl) {
    return blocked({
      layer: 'unconfigured',
      summary: `${name} 的配置里还没有服务地址`,
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
  const model = wireModel(provider, inspection.model || defaultCliModels[provider])
  const shape = probeShape(provider)
  let url: URL
  try {
    url = validateProbeUrl(joinRelayPath(inspection.actualBaseUrl, shape.path))
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
      protocol: shape.protocol,
      method: shape.method,
      url: url.href,
      origin: url.origin,
      headers: shape.headers(inspection.apiKey),
      body: shape.body(model),
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
 * Only the success branch is protocol-specific: every failure the relay
 * reports carries the same envelope whichever endpoint produced it, which is
 * why all four tools share one attribution table.
 */
export function classifyConnectionResponse(
  probe: ConnectionProbeIdentity,
  status: number,
  message: string,
  payload: unknown,
): LayerOutcome & { ok: boolean } {
  const name = cliCatalog[probe.provider].name
  const model = probe.model
  const lowered = message.toLowerCase()
  const hasQuotaHint = includesAny(lowered, quotaHints)
  const hasGroupHint = includesAny(lowered, groupHints)
  const hasModelHint = includesAny(lowered, modelHints)
  const hasCredentialHint = includesAny(lowered, credentialHints)

  if (status >= 200 && status < 300 && !message) {
    return probe.protocol === 'anthropic-messages'
      ? classifyGenerationSuccess(name, status, payload, model)
      : classifyModelCatalogSuccess(name, status, payload, model)
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
    return noAvailableChannel(status)
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

function classifyGenerationSuccess(
  name: string,
  status: number,
  payload: unknown,
  model: string,
): LayerOutcome & { ok: boolean } {
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
    evidence: `已用 ${model} 发过一次最小请求`,
  }
}

/**
 * 模型清单是按令牌所属分组过滤后的，所以「清单空」与「清单里没有这个模型」
 * 分别就是分组层和模型层的答案——不必为了问出这两层而去花一次生成的钱。
 */
function classifyModelCatalogSuccess(
  name: string,
  status: number,
  payload: unknown,
  model: string,
): LayerOutcome & { ok: boolean } {
  if (!looksLikeModelCatalog(payload)) {
    return {
      ok: false,
      layer: 'protocol',
      summary: `服务返回了 HTTP ${status}，但内容不是 ${name} 能识别的模型清单`,
      nextStep: '多半是服务地址指到了网页而不是 API。在首页重新写入一次配置后再试',
    }
  }
  const models = parseModelIds(payload)
  if (models.length === 0) return noAvailableChannel(status)
  if (!models.includes(model)) {
    return {
      ok: false,
      layer: 'model',
      summary: `当前账号可用的 ${models.length} 个模型里没有 ${model}`,
      nextStep: '在首页把这个工具的模型改成列表里仍然可用的一个，再自检一次',
    }
  }
  return {
    ok: true,
    layer: 'network',
    summary: `连接正常，${model} 可以直接使用`,
    nextStep: '无需处理',
    evidence: `已核对当前账号的可用模型清单，${model} 在其中`,
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

function noAvailableChannel(status: number): LayerOutcome & { ok: boolean } {
  return {
    ok: false,
    layer: 'group',
    summary: `当前账号分组下没有可用渠道（HTTP ${status}）`,
    nextStep: '到「账号」页确认这个工具对应的套餐仍在有效期内，再点一次「写入 Key」让客户端重新签发',
  }
}

function looksLikeMessagesResponse(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false
  const record = payload as Record<string, unknown>
  return record.type === 'message' || Array.isArray(record.content) || typeof record.stop_reason === 'string'
}

/**
 * parseModelIds 对「不是清单」和「清单是空的」都回空数组，而那是两个不同的
 * 结论（协议层 vs 分组层），所以形状要先单独判一次。
 */
function looksLikeModelCatalog(payload: unknown): boolean {
  if (Array.isArray(payload)) return true
  if (!payload || typeof payload !== 'object') return false
  const record = payload as Record<string, unknown>
  return Array.isArray(record.data) || Array.isArray(record.models)
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
    ...(outcome.evidence ? { evidence: outcome.evidence } : {}),
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
      method: plan.method,
      headers: plan.headers,
      ...(plan.body ? { body: JSON.stringify(plan.body) } : {}),
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
    const outcome = classifyConnectionResponse(plan, response.status, message, payload)
    const detail = sanitizeUpstreamDetail(message || (payload === null ? bodyText : ''), [plan.apiKey])
    return finish(outcome, {
      endpoint: plan.url,
      model: plan.model,
      status: response.status,
      detail: outcome.ok ? null : detail || null,
    })
  } catch (error) {
    // Only transport failures reach here: the byte cap has its own catch
    // above and a malformed body is handled as a null payload, so anything
    // thrown at this point means no usable answer came back. It is not
    // swallowed -- the runtime's own message travels on as `detail`.
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

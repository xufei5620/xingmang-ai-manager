// @renderer-importable: bundled into the renderer, so no Node or Electron here or in what it value-imports (I6).

/**
 * 余额用完、Key 额度上限用完、Key 失效，在中转那里是三件完全不同的事，用户要做的也
 * 完全不同：第一件去充值，第二件去调高上限，第三件换一把 Key。以前软件自己的对话把
 * 401/403 一律说成「Key 无权使用」，余额不足的用户于是去重写 Key、重装，甚至退款。
 *
 * 这里只认服务端自己写死的那几句话和错误码，全部逐行对过源码：
 * - new-api v1.0.0-rc.24（生产 xm 站）：
 *   - 钱包余额不足：service/billing_session.go，HTTP 403，code insufficient_user_quota，
 *     message「用户额度不足, 剩余额度: …」或「预扣费额度失败, …」；订阅用完是
 *    「订阅额度不足或未配置订阅: …」，同一个 code。
 *   - Key 额度还剩一点但不够这一次预扣：HTTP 403，code pre_consume_token_quota_failed，
 *     message「token quota is not enough, token remain quota: …」（service/quota.go）。
 *   - Key 额度一旦用到 0：middleware/auth.go 回 401「无效的令牌」，和 Key 被删、过期
 *     一字不差（model/token.go ValidateUserToken 对三者返回同一个 ErrTokenInvalid）。
 *     i18n 里那句「该令牌额度已用尽 TokenStatusExhausted[…]」定义了却没有代码用到，
 *     这里仍收下它，服务端哪天用上时不用再改。
 * - Sub2API（历史账号站）：余额 403 INSUFFICIENT_BALANCE「Insufficient account
 *   balance」；Key 额度用完 429「API key 额度已用完」（OpenAI 兼容路径的 code 是
 *   insufficient_quota）；Key 失效 401 INVALID_API_KEY / API_KEY_DISABLED，过期
 *   403 API_KEY_EXPIRED。
 *
 * 刻意不认光秃秃的 insufficient_quota / quota：上游渠道自己欠费时，中转把上游原文
 * 转回来也是这个词，那是服务端的事，叫用户去充值就错了。
 *
 * Zero-dependency on purpose: the renderer imports the finished sentences below to
 * recognise them again (same arrangement as network-failure.ts), so nothing here
 * may pull in a Node module.
 */
export type RelayQuotaFailure = 'balance' | 'keyLimit' | 'keyInvalid'

export const relayQuotaFailureMessages: Readonly<Record<RelayQuotaFailure, string>> = {
  balance: '当前账号余额不足，请充值后重试，无需重新登录或重新填写密钥',
  keyLimit: '该密钥设置的额度上限已用完，请在「个人中心 › 密钥管理」中调高上限后重试',
  keyInvalid: '当前账号的密钥已失效，重新发送后将自动更换新密钥',
}

const balancePattern = /insufficient_user_quota|用户额度不足|预扣费额度失败|订阅额度不足|user quota is not enough|INSUFFICIENT_BALANCE|insufficient account balance/i
const keyLimitPattern = /pre_consume_token_quota_failed|token quota is not enough|令牌额度已用尽|令牌额度不足|TokenStatusExhausted|API_KEY_QUOTA_EXHAUSTED|API key 额度已用完/i
const keyInvalidPattern = /无效的令牌|该令牌已过期|该令牌状态不可用|未提供令牌|INVALID_API_KEY|API_KEY_DISABLED|API_KEY_EXPIRED|API key 已过期|invalid api key/i

/**
 * `detail` is whatever text the caller could safely extract from the error body
 * (message and, when available, code). Order matters: the balance and key-limit
 * phrases are narrower than a bare 401, so they win even on that status.
 */
export function classifyRelayQuotaFailure(status: number, detail: string): RelayQuotaFailure | null {
  if (status !== 401 && status !== 402 && status !== 403 && status !== 429) return null
  if (balancePattern.test(detail)) return 'balance'
  if (keyLimitPattern.test(detail)) return 'keyLimit'
  if (status === 402) return 'balance'
  if (status === 401 || keyInvalidPattern.test(detail)) return 'keyInvalid'
  return null
}

/**
 * Pulls message and code out of the three error envelopes the two relay
 * backends use: OpenAI style `{ error: { message, code } }`, Anthropic style
 * `{ type: 'error', error: { type, message } }`, and Sub2API's bare
 * `{ code, message }`. Anything else yields an empty string, never a throw.
 */
export function extractRelayErrorDetail(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return ''
  const record = payload as Record<string, unknown>
  const nested = record.error && typeof record.error === 'object' && !Array.isArray(record.error)
    ? record.error as Record<string, unknown>
    : null
  const source = nested ?? record
  const parts = [source.message, source.code, source.type]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
  if (!nested && typeof record.error === 'string') parts.unshift(record.error)
  return parts.join(' ')
}

/**
 * Sub2API 计费复查没过时的那句余额不足（#1093 第12a条、#1240）。对过 Wei-Shaw/sub2api 270eac6 与 b0a02a3：
 * 过了鉴权以后 handler 还要复查一次计费（openai_chat_completions.go、openai_images.go 等的
 * CheckBillingEligibility，以及在途余额预留 reserveInflightBalance），没过回的是
 * `{"error":{"type":"billing_error","message":"insufficient balance"}}`（billingErrorDetails；原话是
 * redeem_service.go 的 ErrInsufficientBalance，跟鉴权中间件那句「Insufficient account balance」不同，
 * 也不带 INSUFFICIENT_BALANCE，所以上面那套认不出）。同一句有三种到法：
 * - 开流之前：HTTP 403 加这段 JSON（billing_error 一律配 403）。调用方自己先看状态码是不是 403。
 * - 流到一半：流式请求排队等并发槽位超过 10 秒，它先回 200 和 SSE 心跳占住连接，拿到槽位后复查没过，
 *   只能就地发一帧（handleStreamingAwareErrorWithCode）。
 * - Claude 兼容分组排队回过心跳以后：gateway_handler_chat_completions.go 用普通 JSON 回错、不看
 *   streamStarted，这段 JSON 不带 data: 前缀直接接在心跳后面。
 *
 * 只在历史账号站上认它。new-api 预扣费在开流之前（rc.45 controller/relay.go 的 PrepareRequestBilling），
 * 开流后只结算不报错，自己的余额不足说的是上面 balancePattern 那几句；xm 站出现这句，只可能是渠道
 * 上游原样转回来的（stream_scanner 照转上游的 data 行，HTTP 错误也带上游原话），那是服务端欠费，
 * 叫客户充值就错了。别的复查没过（订阅日限、订阅失效）也回 billing_error，充值解决不了，不认。
 */
export function classifySub2apiBillingFailure(payload: unknown): RelayQuotaFailure | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const error = (payload as Record<string, unknown>).error
  if (!error || typeof error !== 'object' || Array.isArray(error)) return null
  const { type, message } = error as Record<string, unknown>
  if (type !== 'billing_error' || typeof message !== 'string') return null
  return message.trim().toLowerCase() === 'insufficient balance' ? 'balance' : null
}

const relayQuotaFailures: readonly RelayQuotaFailure[] = ['balance', 'keyLimit', 'keyInvalid']

/**
 * Recognises one of the finished sentences above after it crossed IPC. A
 * rejected invoke arrives wrapped as "Error invoking remote method '…': Error:
 * <sentence>", so containment, not equality, is the test.
 */
export function matchRelayQuotaFailureMessage(message: string): RelayQuotaFailure | null {
  return relayQuotaFailures.find((kind) => message.includes(relayQuotaFailureMessages[kind])) ?? null
}

/**
 * 写 Key 前拿它查一次模型（system-service.ts 的 fetchAvailableModels），被中转拒了时抛的
 * 那句话的开头，后面接状态码和服务端原话，例如「模型查询失败，服务返回 401：无效的令牌」。
 * 主进程里自动换 Key 的两处（account-cli-provisioner、chat-credential-coordinator）认的是
 * 这句里的「服务返回 401」，所以这句话本身不改写，渲染层拿它回到上面同一份认法。
 */
export const modelProbeFailurePrefix = '模型查询失败，服务返回'

/**
 * 查模型时中转说这把 Key 所在的分组账号现在用不了：new-api 回 403「无权访问 X 分组」（分组还在、账号不在可用名单里）
 * 或「分组 X 已被弃用」（分组整个删了），英文系统拿到的是英文那两句（rc.51 middleware/auth.go TokenAuth，
 * i18n/locales 的 auth.token_group_forbidden / auth.token_group_deprecated）。Key 本身没坏，换一把能用分组里的就好，
 * 同 account-cli-provisioner.ts 的 isGroupRejection。只认查模型那句后面接的，账号接口的 403 不算。
 */
export function isKeyGroupRejectionMessage(message: string): boolean {
  const start = message.indexOf(modelProbeFailurePrefix)
  if (start < 0) return false
  const probe = message.slice(start + modelProbeFailurePrefix.length)
  return /^\s*403(?!\d)/.test(probe)
    && /无权访问\s.+\s分组|分组\s.+\s已被弃用|no permission to access group\s|group\s.+\shas been deprecated/i.test(probe)
}

/**
 * Finds the model-probe sentence inside a longer failure (the one-click switch
 * and key sync wrap it in their own words) and classifies it with the status
 * and wording it carries. Anything else yields null, so a 401 from the account
 * API is never mistaken for a dead key here.
 */
export function relayQuotaFailureInMessage(message: string): RelayQuotaFailure | null {
  const start = message.indexOf(modelProbeFailurePrefix)
  if (start < 0) return null
  const probe = message.slice(start + modelProbeFailurePrefix.length)
  const status = /^\s*(\d{3})(?!\d)/.exec(probe)
  return status ? classifyRelayQuotaFailure(Number(status[1]), probe) : null
}

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
  balance: '当前账号余额不足，充值后再试就行，不用重新登录，也不用重写 Key',
  keyLimit: '这把 Key 设置的额度上限用完了，到「账号 → 密钥」调高上限后再试',
  keyInvalid: '当前账号的 Key 已失效，点「重试」会自动换一把新的',
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

const relayQuotaFailures: readonly RelayQuotaFailure[] = ['balance', 'keyLimit', 'keyInvalid']

/**
 * Recognises one of the finished sentences above after it crossed IPC. A
 * rejected invoke arrives wrapped as "Error invoking remote method '…': Error:
 * <sentence>", so containment, not equality, is the test.
 */
export function matchRelayQuotaFailureMessage(message: string): RelayQuotaFailure | null {
  return relayQuotaFailures.find((kind) => message.includes(relayQuotaFailureMessages[kind])) ?? null
}

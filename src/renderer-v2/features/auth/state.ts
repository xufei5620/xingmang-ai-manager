import { matchNetworkFailureMessage } from '../../../../electron/network-failure'
import { matchAccountErrorMessage } from './account-errors'

export interface RegistrationDraft { email: string; username: string; password: string; confirm: string; code: string; invite: string; agreed: boolean }
export type RegistrationErrors = Partial<Record<keyof RegistrationDraft, string>>
export type RecoveryCodeResult = { ok: true; token: string; source: 'code' | 'link' } | { ok: false; error: string }

export const accountSources = {
  solov: { label: '星芒账号', website: 'https://xm.solov.cc', supportsPasswordReset: true },
  'solov-api': { label: '历史账号', website: 'https://api.solov.cc', supportsPasswordReset: false },
} as const

export function isEmail(value: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim())
}

export function parseRecoveryCode(value: string, expectedOrigin?: string): RecoveryCodeResult {
  const text = value.trim()
  if (!text) return { ok: false, error: '请粘贴邮件中的重置码或完整链接' }
  if (/\s/.test(text)) return { ok: false, error: '重置码不能包含空格或换行，请重新复制' }
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) {
    let url: URL
    try { url = new URL(text) } catch { return { ok: false, error: '链接格式不完整，请重新复制邮件中的链接' } }
    if (!['https:', 'http:'].includes(url.protocol)) return { ok: false, error: '只支持邮件中的 HTTP 或 HTTPS 链接' }
    if (expectedOrigin && url.origin !== expectedOrigin) return { ok: false, error: '重置链接不属于所选账号来源，请使用该账号的重置邮件' }
    const tokens = url.searchParams.getAll('token')
    if (tokens.length !== 1) return { ok: false, error: tokens.length ? '链接中包含多个重置码，请重新获取邮件' : '链接中没有重置码，请复制邮件中的完整链接' }
    const token = tokens[0]
    if (!token || /\s/.test(token)) return { ok: false, error: '链接中的重置码为空或包含空格，请重新获取邮件' }
    return { ok: true, token, source: 'link' }
  }
  return { ok: true, token: text, source: 'code' }
}

// 注册表单的本地校验只为省一次往返并给中文提示，服务端才是权威。长度规则
// 不是猜的：new-api 的 model.User 结构体标签是 Username `validate:"max=20"`、
// Password `validate:"min=8,max=20"`，用户名没有下限也没有字符集限制，所以这里
// 同样不加下限——否则两位的用户名服务端收、客户端却先拦下来（审查总表 R-G10）。
// 旧版渲染层 src/components/account/validation.ts 有同一份规则，这是 I6/I7 下
// 的有意重复（renderer-v2 不 import 旧界面，两边各自带单测）。
const maxUsernameLength = 20
const minPasswordLength = 8
const maxPasswordLength = 20
// model.User.AffCode 是 varchar(32)，默认生成 4 位，列宽才是真正的上限。
const maxInviteCodeLength = 32

/**
 * 注册时替用户想好的用户名：邮箱 @ 前面那段。服务端对用户名只限长度（上面的注释），
 * 所以合规只需要按字符截到 20 位；按码点截，免得把一个表情或生僻字劈成半个。
 * 还没打到 @ 时整段都算前缀，用户边敲邮箱边能看到用户名跟着变。
 */
export function usernameFromEmail(email: string): string {
  const local = email.trim().split('@')[0] ?? ''
  return Array.from(local).slice(0, maxUsernameLength).join('')
}

function looksLikeInviteLink(value: string): boolean {
  return /^https?:\/\//i.test(value) || value.includes('aff=') || /\/(sign-up|register)\b/i.test(value)
}

/** 既接受裸邀请码，也接受邀请海报上那种没带协议头的链接；空值合法（邀请码可不填）。 */
export function parseInviteCode(value: string): string {
  const text = value.trim()
  if (!text) return ''
  if (!looksLikeInviteLink(text)) return text
  const query = text.includes('?') ? text.slice(text.indexOf('?') + 1) : text
  return new URLSearchParams(query).get('aff')?.trim() ?? ''
}

export function validateRegistration(draft: RegistrationDraft, verificationRequired: boolean): RegistrationErrors {
  const errors: RegistrationErrors = {}
  const username = draft.username.trim()
  const invite = draft.invite.trim()
  if (!isEmail(draft.email)) errors.email = '请填写正确的邮箱'
  if (!username) errors.username = '请填写用户名'
  else if (Array.from(username).length > maxUsernameLength) errors.username = `用户名不能超过 ${maxUsernameLength} 位`
  if (draft.password.length < minPasswordLength) errors.password = `密码至少 ${minPasswordLength} 位`
  else if (draft.password.length > maxPasswordLength) errors.password = `密码不能超过 ${maxPasswordLength} 位`
  if (!draft.confirm) errors.confirm = '请再次输入密码'
  else if (draft.password !== draft.confirm) errors.confirm = '两次密码不一致'
  if (verificationRequired && !draft.code.trim()) errors.code = '请填写邮件中的验证码'
  if (invite) {
    const parsed = parseInviteCode(invite)
    if (!parsed) errors.invite = '邀请链接中没有邀请码，请检查后重试'
    else if (parsed.length > maxInviteCodeLength) errors.invite = `邀请码不能超过 ${maxInviteCodeLength} 位`
  }
  if (!draft.agreed) errors.agreed = '请先同意用户协议和隐私政策'
  return errors
}

export function remainingCooldown(deadline: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000))
}

export function authErrorMessage(error: unknown, action: string): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  if (/账号安全存储不可用|本地账号存储/.test(message)) return '本地账号安全存储暂不可用，原有数据已保留。请完全退出软件后重试；若仍失败，请联系支持并提供诊断日志。'
  if (requiresBrowserAuthentication(error)) return '此账号需要双重验证。客户端暂不支持该验证方式，请前往所选账号官网登录或联系官网客服。'
  // 主进程已经把受限网络下的失败分好类并写好了中文（DNS / 证书被替换 / 门户认证
  // 未完成 / 连接被切断），原样上屏。放在启发式之前：下面那几条正则宽到会把
  // 「证书被替换」也说成「连接超时」，那会让用户在一个换网络才能解决的问题上
  // 一遍遍重试密码。文案只有 electron/network-failure.ts 一份，不在这里复述。
  const network = matchNetworkFailureMessage(message)
  if (network) return network
  // The precise new-api table runs before the heuristics below: those are broad
  // enough to swallow a message whose real cause the server already named. A
  // change-password failure saying the original password is wrong would
  // otherwise hit /密码|password/ and come out as "账号或密码不正确".
  const known = matchAccountErrorMessage(message)
  if (known) return known
  if (/429|频繁|too many|rate limit/i.test(message)) return '请求太频繁，请稍等一分钟再试'
  if (/已存在|占用|already exists/i.test(message)) return '用户名或邮箱已被使用，请检查后重试'
  if (/验证码|verification code/i.test(message)) return '验证码不正确或已过期，请重新获取'
  if (/重置/.test(action) && /token|重置码|expired|过期/i.test(message)) return '重置码已失效，请重新获取邮件'
  if (/用户名|密码|credential|password|unauthorized/i.test(message)) return '账号或密码不正确，请检查后重试'
  if (/timeout|timed.?out|超时|network|fetch|connect|网络/i.test(message)) return '连接星芒服务器超时，请检查网络后重试'
  if (/turnstile|人机/i.test(message)) return '服务端需要完成安全验证，请在浏览器完成后再试'
  return `${action}没有成功，输入已保留，请稍后重试`
}

export function requiresBrowserAuthentication(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return /TWO_FACTOR_REQUIRED|双重验证|两步验证|2fa|two.factor/i.test(message)
}

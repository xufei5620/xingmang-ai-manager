// Maps a new-api server error message to a friendlier, actionable Chinese
// string for display in a toast (I13 already sanitized it upstream in
// electron/new-api-client.ts -- this is presentation, not security).
//
// new-api's default response language is English for this client:
// electron/new-api-client.ts's fetch calls send no Accept-Language header,
// and QuantumNous/new-api's i18n.GetLangFromContext falls back to its
// DefaultLang (English) when none is found. That is exactly why the bug
// this refactor exists to fix surfaced as the literal English string
// "Username already exists" instead of a Chinese one.
//
// Patterns match on message *content* (case-insensitive substrings), not
// exact equality: the customized xm.solov.cc branch is already known to
// phrase at least one of these differently from the upstream
// QuantumNous/new-api repo ("Username already exists" vs. upstream's
// "Username already exists or has been deleted", confirmed by reading
// controller/user.go's Register handler and i18n/locales/en.yaml's
// `user.exists` key -- see docs/RECON-new-api.md), so exact string matching
// would be fragile. Both the confirmed-English phrasing and new-api's own
// official Chinese translation (i18n/locales/zh-CN.yaml) are matched, so
// this keeps working if the server's language negotiation ever changes.
//
// Unmatched messages are returned unchanged (trimmed) rather than replaced
// with a generic "出错了": the caller's message has already been sanitized,
// so passing it through keeps real, unanticipated server errors visible
// instead of silently swallowing them.
interface AccountErrorPattern {
  test: RegExp
  friendly: string
}

const accountErrorPatterns: readonly AccountErrorPattern[] = [
  {
    // i18n key user.exists -- register-time username collision. This is the
    // exact failure this refactor exists to fix: registering with the email
    // address as a stand-in username collided with a prior attempt's.
    test: /username\s+already\s+exists|用户名已存在/i,
    friendly: '该用户名已被注册，请更换用户名，或点击"去登录"',
  },
  {
    // i18n key user.email_already_taken -- register-time email collision.
    test: /email(\s+address)?\s+is\s+already\s+in\s+use|邮箱地址已被占用|该邮箱已注册/i,
    friendly: '该邮箱已被注册，请直接登录，或更换邮箱后重试',
  },
  {
    // i18n key user.verification_code_error
    test: /verification\s+code.*(incorrect|invalid|expired)|验证码(错误|不正确|已过期|已失效)/i,
    friendly: '验证码错误或已过期，请重新获取验证码',
  },
  {
    // i18n key user.password_reset_link_invalid -- wrong/already-used/expired
    // reset token submitted to account:reset-password. English default:
    // "Password reset link is invalid or has expired" (confirmed against
    // QuantumNous/new-api's controller/misc.go ResetPassword handler and its
    // own i18n/locales/en.yaml text); Chinese translation from the same
    // locale file's zh-CN.yaml is matched too, same reasoning as the other
    // patterns in this file.
    test: /password reset link is invalid or has expired|重置链接(非法|无效)(或已过期)?/i,
    friendly: '重置码错误或已过期，请重新获取重置邮件',
  },
  {
    // i18n key user.email_verification_required -- submitted without an
    // email/code while the server has email verification turned on. Actual
    // en.yaml text is "Email verification is enabled, please enter email
    // address and verification code" -- no "required" substring, despite
    // the key's own name.
    test: /email verification is enabled|please enter email address and verification code|请输入邮箱地址和验证码/i,
    friendly: '请输入邮箱地址并获取验证码',
  },
  {
    // i18n key user.username_or_password_error, plus defensive coverage for
    // "account not found" phrasing a different new-api version might use --
    // both collapse to the same generic message on purpose, matching
    // new-api's own behavior of never confirming which half was wrong.
    test: /username or password is incorrect|user does not exist|no such user|account does not exist|用户名或密码错误|用户不存在/i,
    friendly: '用户名或密码错误',
  },
  {
    // i18n key auth.user_banned, standalone (the login path already folds
    // this into the generic message above, but other paths can surface it
    // alone).
    test: /user has been banned|用户已被封禁/i,
    friendly: '该账号已被封禁，请联系客服',
  },
  {
    // i18n keys user.register_disabled / user.password_register_disabled
    test: /registration has been disabled|注册(功能)?已(关闭|禁用)/i,
    friendly: '当前暂未开放注册，请联系客服',
  },
  {
    // i18n key user.password_login_disabled
    test: /password login has been disabled|密码登录已(关闭|禁用)/i,
    friendly: '当前暂不支持密码登录，请联系客服',
  },
  {
    // i18n key common.database_error
    test: /database error|数据库出错/i,
    friendly: '服务暂时不可用，请稍后重试',
  },
  {
    // i18n key user.original_password_error -- 个人中心「安全」Tab 的修改密码
    // (W4b), 原密码与账号当前密码不匹配. English text confirmed directly from
    // QuantumNous/new-api's i18n/locales/en.yaml at the exact v1.0.0-rc.24 tag
    // xm.solov.cc is pinned to: "Original password is incorrect"; Chinese
    // translation from that same locale file's zh-CN.yaml: "原密码错误".
    test: /original password is incorrect|原密码错误/i,
    friendly: '原密码错误，请重新输入',
  },
  {
    // i18n key user.password_unset -- change-password attempted on an
    // OAuth-only account that has never had a password to verify against
    // (checkUpdatePassword, controller/user.go). Confirmed the same way as
    // the pattern immediately above, at the same tag: en.yaml "This account
    // has no password set. Please use password reset or contact an
    // administrator to reset it."; zh-CN.yaml "当前账号未设置密码，请使用密码
    // 重置或联系管理员重置密码".
    test: /this account has no password set|当前账号未设置密码/i,
    friendly: '当前账号未设置密码，请先通过"忘记密码"设置密码',
  },
]

export function resolveAccountErrorMessage(message: string): string {
  const trimmed = message.trim()
  if (!trimmed) return trimmed
  const matched = accountErrorPatterns.find((pattern) => pattern.test.test(trimmed))
  return matched ? matched.friendly : trimmed
}

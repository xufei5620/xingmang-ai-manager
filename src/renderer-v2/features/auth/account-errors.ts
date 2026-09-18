// renderer-v2's own copy of the new-api server-error table. The legacy shell
// keeps an equivalent table in src/components/account/account-errors.ts and the
// two are intentionally separate (same reasoning as I6/I7: neither renderer may
// reach into the other's tree, and each carries its own unit test). Keep the
// patterns in sync when the server's wording changes -- both files are matched
// against the same docs/RECON-new-api.md facts.
//
// Matching is on message *content* (case-insensitive substrings), not exact
// equality: the customized xm.solov.cc branch already phrases at least one of
// these differently from upstream QuantumNous/new-api, and messages that cross
// IPC arrive wrapped in "Error invoking remote method '...':". Both new-api's
// English default (no Accept-Language header is sent, so its i18n falls back to
// English) and its own zh-CN translation are matched, so this keeps working if
// the server's language negotiation ever changes.
//
// This resolves only what the table knows. Unmatched messages return null so
// the caller keeps its own fallback: unlike the legacy shell, renderer-v2 never
// puts raw server text on screen.
interface AccountErrorPattern {
  test: RegExp
  friendly: string
}

const accountErrorPatterns: readonly AccountErrorPattern[] = [
  {
    // i18n key user.exists -- register-time username collision.
    test: /username\s+already\s+exists|用户名已存在/i,
    friendly: '该用户名已被注册，请更换用户名，或点击“已有账号，登录”',
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
    // i18n key user.password_reset_link_invalid -- wrong, already-used or
    // expired reset token submitted to account:reset-password.
    test: /password reset link is invalid or has expired|重置链接(非法|无效)(或已过期)?/i,
    friendly: '重置码错误或已过期，请重新获取重置邮件',
  },
  {
    // i18n key user.email_verification_required -- submitted without an email
    // or code while the server has email verification turned on. The actual
    // en.yaml text carries no "required" substring despite the key's name.
    test: /email verification is enabled|please enter email address and verification code|请输入邮箱地址和验证码/i,
    friendly: '请输入邮箱地址并获取验证码',
  },
  {
    // i18n key user.username_or_password_error, plus defensive coverage for the
    // "account not found" phrasing a different new-api version might use --
    // both collapse to the same message on purpose, matching new-api's own
    // behavior of never confirming which half was wrong.
    test: /username or password is incorrect|user does not exist|no such user|account does not exist|用户名或密码错误|用户不存在/i,
    friendly: '用户名或密码错误',
  },
  {
    // i18n key auth.user_banned, standalone (the login path folds this into the
    // generic message above, but other paths can surface it alone).
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
    // i18n key user.original_password_error -- 个人中心的修改密码，原密码与账号
    // 当前密码不匹配。没有这条，v2 会先命中泛化的 /密码|password/ 分支，把改密码
    // 场景说成「账号或密码不正确」。
    test: /original password is incorrect|原密码错误/i,
    friendly: '原密码错误，请重新输入',
  },
  {
    // i18n key user.password_unset -- change-password attempted on an
    // OAuth-only account that never had a password to verify against. 这条尤其
    // 不能退化：用户该去走“找回密码”，而不是反复确认自己的密码。
    test: /this account has no password set|当前账号未设置密码/i,
    friendly: '当前账号未设置密码，请先通过“找回密码”设置密码',
  },
]

export function matchAccountErrorMessage(message: unknown): string | null {
  const text = typeof message === 'string' ? message.trim() : message instanceof Error ? message.message.trim() : ''
  if (!text) return null
  return accountErrorPatterns.find((pattern) => pattern.test.test(text))?.friendly ?? null
}

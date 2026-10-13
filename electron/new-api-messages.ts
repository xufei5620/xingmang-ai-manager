// From v1.0.0-rc.43 on, QuantumNous/new-api no longer translates console
// messages on the server: `message` is always the English sentence, and the
// response also carries `message_key` (the English template, which doubles as
// the key of the web console's locale files) plus `message_params`. Its web
// console looks that key up in web/src/i18n/locales/zh.json. Up to rc.42 the
// server answered in Chinese itself -- hard-coded, or translated by the
// Accept-Language that Electron sends from the app locale. This client has no
// locale bundle of its own, so without this table a Chinese Windows would
// start seeing English the day the server upgrades.
//
// The wording is upstream's own zh.json (v1.0.0-rc.44, commit 633b4c5b),
// limited to what the routes this client calls can answer with: the handlers
// behind every path in new-api-client.ts, all middleware, the models they
// write through, and the security-operation errors
// (controller/secure_verification.go). Messages that only label a log entry
// (RecordLog*) are left out: they never come back as `message`. Against rc.40's
// zh-CN.yaml and its hard-coded Chinese the wording is the same apart from
// spacing around Latin words and a few ID/email field names.
//
// 认不出的 key 照旧交出服务器的英文原话，不吞：渲染层那几张表（account-errors.ts、
// operation-error.ts）还认得英文，认不出的也会作为原话留给客服。

export const chineseServerMessages: ReadonlyMap<string, string> = new Map([
  ['A token can select at most {{max}} Auto groups', '每个令牌最多可选择 {{max}} 个 Auto 分组'],
  ['Account bindings have changed. Start this operation again.', '账户绑定已变化，请重新操作。'],
  ['Add another login method before unlinking this account.', '请先添加其他登录方式，再解除此账户绑定。'],
  ['Another log export is running. Try again after it finishes.', '已有一个日志导出正在进行，请等它完成后再试。'],
  ['Auto group {{group}} is duplicated', 'Auto 分组 {{group}} 重复'],
  ['Auto group {{group}} is unavailable or unauthorized', 'Auto 分组 {{group}} 不可用或无权访问'],
  ['Bark push URL cannot be empty', 'Bark 推送 URL 不能为空'],
  ['Callback URL configuration error', '回调地址配置错误'],
  ['Cannot create users with permission level equal to or higher than yourself', '无法创建权限大于等于自己的用户'],
  ['Cannot delete super administrator account', '不能删除超级管理员账户'],
  ['Cannot demote super administrator user', '无法降级超级管理员用户'],
  ['Cannot disable super administrator user', '无法禁用超级管理员用户'],
  ['Creem webhook is not configured', 'Creem Webhook 未配置'],
  ['CreemProductId is not configured for this plan', '该套餐未配置 CreemProductId'],
  ['Current password is incorrect.', '当前密码不正确。'],
  ['Custom reset cycle must be greater than 0 seconds', '自定义重置周期需大于0秒'],
  ['Database connection failed', '数据库连接失败'],
  ['Database error, please contact the administrator', '数据库出错，请联系管理员'],
  ['Discord ID is empty!', 'Discord ID 为空！'],
  ['Downgrade group does not exist', '降级分组不存在'],
  ['Email address is already in use', '邮箱地址已被占用'],
  ['Email is empty!', '邮箱为空！'],
  ['Email or password is empty!', '邮箱地址或密码为空！'],
  ['Email verification code is incorrect.', '邮箱验证码不正确。'],
  ['Email verification is enabled, please enter email address and verification code', '管理员开启了邮箱验证，请输入邮箱地址和验证码'],
  ['Failed to create default token', '创建默认令牌失败'],
  ['Failed to create order', '创建订单失败'],
  ['Failed to export logs', '导出日志失败'],
  ['Failed to generate default token', '生成默认令牌失败'],
  ['Failed to generate token', '生成令牌失败'],
  ['Failed to get the token count', '获取令牌数量失败'],
  ['Failed to get the user group', '获取用户分组失败'],
  ['Failed to query logs', '查询日志失败'],
  ['Failed to query statistics', '查询统计数据失败'],
  ['Failed to regenerate backup codes', '重新生成备份代码失败'],
  ['Failed to save backup codes', '保存备用码失败'],
  ['Failed to search tokens', '搜索令牌失败'],
  ['Failed to search top-up records', '搜索充值记录失败'],
  ['Failed to start payment', '拉起支付失败'],
  ['Fuzzy search keywords must be at least 2 characters long', '使用模糊搜索时，关键词长度至少为 2 个字符'],
  ['GitHub ID is empty!', 'GitHub ID 为空！'],
  ['Gotify server URL cannot be empty', 'Gotify 服务器地址不能为空'],
  ['Gotify token cannot be empty', 'Gotify 令牌不能为空'],
  ['ID is empty', 'ID 为空'],
  ['ID is empty!', 'ID 为空！'],
  ['Insufficient balance', '余额不足'],
  ['Invalid Bark push URL', '无效的 Bark 推送 URL'],
  ['Invalid Gotify server URL', '无效的 Gotify 服务器地址'],
  ['Invalid ID', '无效的 ID'],
  ['Invalid Passkey domain. Enter a domain without a scheme, port, path or wildcard.', '通行密钥域名无效。请填写域名，不包含协议、端口、路径或通配符。'],
  ['Invalid Webhook URL', '无效的 Webhook 地址'],
  ['Invalid email address', '无效的邮箱地址'],
  ['Invalid input', '输入不合法'],
  ['Invalid input {{error}}', '输入不合法 {{error}}'],
  ['Invalid parameters', '无效的参数'],
  ['Invalid subscription ID', '无效的订阅ID'],
  ['Invalid top-up amount', '充值数量无效'],
  ['Invalid top-up quota', '无效的充值额度'],
  ['Invalid user ID', '无效的用户 ID'],
  ['Invalid warning type', '无效的预警类型'],
  ['Invitation quota is insufficient!', '邀请额度不足！'],
  ['Legacy access tokens have been retired. Create a new access token in security settings', '旧版访问令牌已停用，请在安全设置中创建新的访问令牌'],
  ['Log export is disabled', '日志导出已关闭'],
  ['Long passwords are unavailable until the password storage upgrade is complete.', '密码存储升级完成前暂不支持长密码。'],
  ['Maximum number of tokens reached ({{max}})', '已达到最大令牌数量限制 ({{max}})'],
  ['Minimum transfer quota is {{min}}!', '转移额度最小为{{min}}！'],
  ['New password must be different from current password', '新密码必须与当前密码不同'],
  ['New user registration has been disabled by administrator', '管理员关闭了新用户注册'],
  ['No Passkey is registered.', '尚未注册 Passkey。'],
  ['No permission to access users of same or higher level', '无权获取同级或更高等级用户的信息'],
  ['No permission to change the 2FA settings of users at the same or higher level', '无权操作同级或更高级用户的2FA设置'],
  ['No permission to update users of same or higher permission level', '无权更新同权限等级或更高权限等级的用户信息'],
  ['OIDC ID is empty!', 'OIDC ID 为空！'],
  ['Order is not pending payment and cannot be completed', '订单状态不是待支付，无法补单'],
  ['Order number not provided', '未提供订单号'],
  ['Password login has been disabled by administrator', '管理员关闭了密码登录'],
  ['Password must contain between 8 and 128 characters.', '密码长度必须为 8–128 个字符。'],
  ['Password registration has been disabled by administrator, please use third-party account verification', '管理员关闭了通过密码进行注册，请使用第三方账户验证的形式进行注册'],
  ['Password reset link is invalid or has expired', '重置链接非法或已过期'],
  ['Password settings have changed. Reload the page and try again.', '密码设置已变化，请刷新页面后重试。'],
  ['Payment amount is too low', '充值金额过低'],
  ['Payment information has not been configured by administrator', '当前管理员未配置支付信息'],
  ['Payment method does not exist', '支付方式不存在'],
  ['Payment, redemption, subscription, and invitation reward features are disabled. The administrator must confirm compliance terms before enabling them.', '支付、兑换码、订阅计划和邀请返利功能已禁用。管理员需先确认合规声明后方可启用。'],
  ['Plan amount is too low', '套餐金额过低'],
  ['Please enter a valid email address', '请输入有效的电子邮件地址'],
  ['Please wait before requesting another verification code.', '请稍后再请求验证码。'],
  ['Please wait {{seconds}} seconds before requesting another verification code.', '发送过于频繁，请等待 {{seconds}} 秒后再试'],
  ['Price cannot be negative', '价格不能为负数'],
  ['Price cannot exceed 9999', '价格不能超过9999'],
  ['Purchase limit cannot be negative', '购买上限不能为负数'],
  ['Purchase limit for this plan has been reached', '已达到该套餐购买上限'],
  ['Quota unit is misconfigured', '额度单位配置错误'],
  ['Quota value cannot be negative', '额度值不能为负数'],
  ['Quota value exceeds valid range, maximum is {{max}}', '额度值超出有效范围，最大值为 {{max}}'],
  ['Redemption failed, please try again later', '兑换失败，请稍后重试'],
  ['Regular administrators cannot promote other users to administrator', '普通管理员用户无法提升其他用户为管理员'],
  ['SMTP server is not configured', 'SMTP 服务器未配置'],
  ['Stripe is not configured or key is invalid', 'Stripe 未配置或密钥无效'],
  ['Stripe webhook is not configured', 'Stripe Webhook 未配置'],
  ['StripePriceId is not configured for this plan', '该套餐未配置 StripePriceId'],
  ['Subscription plan is not enabled', '套餐未启用'],
  ['Subscription plan title cannot be empty', '套餐标题不能为空'],
  ['Telegram ID is empty!', 'Telegram ID 为空！'],
  ['Telegram OAuth is not configured or enabled. Please contact your administrator.', 'Telegram OAuth 尚未配置或启用，请联系管理员。'],
  ['Telegram authorization failed. Please try again.', 'Telegram 授权失败，请重试。'],
  ['The OAuth account does not match the account linked to your profile.', '此 OAuth 账号与已绑定的账号不一致。'],
  ['The access token lacks the required permission: {{scope}}', '访问令牌缺少所需权限：{{scope}}'],
  ['The action details are invalid.', '操作信息无效。'],
  ['The authenticator code is incorrect.', '认证器验证码错误。'],
  ['The current sign-in method does not support security verification', '当前认证方式不支持安全验证'],
  ['The search pattern can contain at most 2 % wildcards', '搜索模式中最多允许包含 2 个 % 通配符'],
  ['The search pattern cannot contain consecutive % wildcards', '搜索模式中不允许包含连续的 % 通配符'],
  ['The telegram OAuth provider name is reserved. Ask your administrator to rename the conflicting custom provider.', 'telegram 是保留的 OAuth 提供方名称，请联系管理员重命名冲突的自定义提供方。'],
  ['The time range cannot exceed {{days}} days', '时间跨度不能超过 {{days}} 天'],
  ['The two-factor setup has expired or changed. Start setup again.', '两步验证设置已过期或变更，请重新设置。'],
  ['This API is deprecated', '该接口已废弃'],
  ['This Passkey domain is not available on this website. Use its original website or another verification method.', '此通行密钥域名无法在当前网站使用。请前往原网站或选择其他验证方式。'],
  ['This Telegram account is already bound.', '此 Telegram 账户已被绑定。'],
  ['This Telegram account is not linked. Sign in using another method and link it first.', '此 Telegram 账号尚未绑定，请先通过其他方式登录并绑定。'],
  ['This email address is already in use.', '此邮箱地址已被使用。'],
  ['This email address is not allowed by the administrator\'s email policy.', '此邮箱地址不符合管理员设置的邮箱规则。'],
  ['This external account is already bound.', '此第三方账户已被绑定。'],
  ['This plan does not allow balance redemption', '该套餐不允许使用余额兑换'],
  ['This user has no active subscription to this plan', '该用户没有有效的此套餐订阅'],
  ['This user is already a common user', '该用户已经是普通用户'],
  ['This user is already an administrator', '该用户已经是管理员'],
  ['This verification method is currently unavailable.', '此验证方式当前不可用。'],
  ['This verification method is not allowed for this action.', '此操作不允许使用该验证方式。'],
  ['This verification method requires its dedicated verification flow.', '此验证方式需要通过专用验证流程完成。'],
  ['Token ID or user ID is empty', '令牌 ID 或用户 ID 为空'],
  ['Token IDs cannot be empty', '令牌 ID 不能为空'],
  ['Token count exceeds the limit. Only exact search is allowed, do not use the % wildcard', '令牌数量超过上限，仅允许精确搜索，请勿使用 % 通配符'],
  ['Token has expired and cannot be enabled. Please modify the expiration time or set it to never expire', '令牌已过期，无法启用，请先修改令牌过期时间，或者设置为永不过期'],
  ['Token name is too long', '令牌名称过长'],
  ['Token quota is exhausted and cannot be enabled. Please modify the remaining quota or set it to unlimited', '令牌可用额度已用尽，无法启用，请先修改令牌剩余额度，或者设置为无限额度'],
  ['Too many incorrect codes. Start email verification again.', '验证码错误次数过多，请重新开始邮箱验证。'],
  ['Too many items in batch request, maximum is {{max}}', '批量请求数量过多，最多 {{max}} 条'],
  ['Top-up amount cannot be less than {{min}}', '充值数量不能小于 {{min}}'],
  ['Top-up amount cannot exceed {{max}}', '充值数量不能大于 {{max}}'],
  ['Top-up is processing, please try again later', '充值处理中，请稍后重试'],
  ['Top-up order does not exist', '充值订单不存在'],
  ['Top-up quota exceeds the range the system can represent', '充值额度超出系统可表示范围'],
  ['Top-up quota limit exceeded', '超出充值额度上限'],
  ['Top-up quota must be greater than 0', '充值额度必须大于 0'],
  ['Total quota cannot be negative', '总额度不能为负数'],
  ['Transfer failed {{error}}', '划转失败 {{error}}'],
  ['Turnstile token is empty', 'Turnstile token 为空'],
  ['Turnstile verification failed, please refresh and try again!', 'Turnstile 校验失败，请刷新重试！'],
  ['Two-factor authentication is already enabled.', '两步验证已启用。'],
  ['Two-factor authentication is not enabled.', '两步验证尚未启用。'],
  ['Two-factor authentication is temporarily locked.', '两步验证已暂时锁定。'],
  ['URL must start with http:// or https://', 'URL 必须以 http:// 或 https:// 开头'],
  ['Unauthorized, insufficient privileges', '无权进行此操作，权限不足'],
  ['Unauthorized, invalid access token', '无权进行此操作，access token 无效'],
  ['Unauthorized, invalid user info', '无权进行此操作，用户信息无效'],
  ['Unauthorized, not logged in and no access token provided', '无权进行此操作，未登录且未提供 access token'],
  ['Unauthorized, the access token has expired', '访问令牌已过期'],
  ['Update failed', '更新失败'],
  ['Upgrade group does not exist', '升级分组不存在'],
  ['User does not exist', '用户不存在'],
  ['User group will be reverted to {{group}}', '用户分组将回退到 {{group}}'],
  ['User group will be upgraded to {{group}}', '用户分组将升级到 {{group}}'],
  ['User has been banned', '用户已被封禁'],
  ['User registration failed or user ID retrieval failed', '用户注册失败或用户ID获取失败'],
  ['Username already exists or has been deleted', '用户名已存在，或已注销'],
  ['Username or password is incorrect, or user has been banned', '用户名或密码错误，或用户已被封禁'],
  ['Verification code is incorrect or has expired', '验证码错误或已过期'],
  ['Verification does not match this action.', '验证与此操作不匹配。'],
  ['Verification email could not be sent. Start email verification again.', '验证邮件发送失败，请重新开始邮箱验证。'],
  ['Verification failed. Please try again.', '验证失败，请重试。'],
  ['Verification flow expired', '验证流程已过期'],
  ['Waffo Pancake is not configured or key is invalid', 'Waffo Pancake 未配置或密钥无效'],
  ['WaffoPancakeProductId is not configured for this plan', '该套餐未配置 WaffoPancakeProductId'],
  ['Wallet quota limit exceeded', '超出钱包额度范围'],
  ['Warning threshold must be greater than 0', '预警阈值必须大于 0'],
  ['WeChat ID is empty!', '微信 ID 为空！'],
  ['Webhook URL cannot be empty', 'Webhook 地址不能为空'],
  ['You do not have permission to perform this action.', '你没有执行此操作的权限。'],
])

// A key or param this long is not one of the table's sentences or a value
// worth showing; fall back to the server's own text instead of growing it.
const maxMessageKeyLength = 512
const maxParamLength = 200

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function paramText(value: unknown): string | null {
  if (typeof value === 'string') return value.length <= maxParamLength ? value : null
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return String(value)
  return null
}

/**
 * The Chinese sentence for an rc.43+ response envelope, or null when the
 * envelope names no key this table knows -- older servers, unknown keys,
 * params that are missing or not plain values. Placeholders are filled in one
 * pass, as upstream's Message.Error() does, so a param that itself contains
 * "{{name}}" is shown as written. The caller still redacts and trims the
 * result: params come from the server just like `message` does.
 */
export function resolveChineseServerMessage(envelope: Record<string, unknown>): string | null {
  const key = envelope.message_key
  if (typeof key !== 'string' || !key || key.length > maxMessageKeyLength) return null
  const template = chineseServerMessages.get(key)
  if (!template) return null
  const values = isPlainRecord(envelope.message_params) ? envelope.message_params : {}
  let complete = true
  const text = template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_placeholder, name: string) => {
    const value = Object.prototype.hasOwnProperty.call(values, name) ? paramText(values[name]) : null
    if (value === null) complete = false
    return value ?? ''
  })
  return complete ? text : null
}

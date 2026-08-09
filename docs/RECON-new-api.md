# new-api 对接技术侦察（xm.solov.cc）

> 侦察日期 2026-08-09；方式：QuantumNous/new-api（原 Calcium-Ion，组织已迁移）源码与官方文档只读检索 + 对生产实例单次 `GET /api/status`。无注册/登录/写操作。
> 实例版本 `v1.0.0-rc.22-solov1`（定制分支，上游同期已到 rc.24，近 3 周连发 4 版，迭代快）。
>
> **更新 2026-08-10（W4a 实测）**：生产实例已升级到 `v1.0.0-rc.24`（不再明显落后上游）。`usd_exchange_rate` 由 7.3 变为 1，但 `quota_per_unit` 仍为 500000（美元换算只依赖 `quota_per_unit`，此变化不影响）。以下端点已对 rc.24 源码逐行核实：`GET /api/user/self`（`buildSelfUserData`，故意不返 access_token/密码/PAT）、`GET /api/log/self`（分页 `p`/`page_size`，服务端 clamp≤100，响应 `{page,page_size,total,items}`）、充值页 SPA 路由 `/wallet`、邀请链接参数 `?aff=<code>`。下文 rc.22 时点的字段快照与陷阱叙述仍保留作侦察历史。

## A. 端点清单

| 分类 | 端点 | 鉴权 | 关键字段 |
|---|---|---|---|
| 注册 | `POST /api/user/register` | 公开+Turnstile(按开关) | username, password, email, verification_code, aff_code |
| 登录 | `POST /api/user/login` | 公开+Turnstile | 响应体 `access_token`/`access_expires_at`/`user`；同时 Set-Cookie 下发 HttpOnly refresh token |
| 2FA | `POST /api/user/login/2fa` | CriticalRateLimit | flow_token 补登录 |
| 续期 | `POST /api/user/auth/refresh` | 凭 refresh cookie | 换新 access_token |
| 登出 | `POST /api/user/auth/logout` | 会话 | 清 session |
| 用户信息 | `GET/PUT/DELETE /api/user/self` | UserAuth | quota(整数余额)/used_quota/group/role/aff_* |
| 系统访问令牌(PAT) | `GET /api/user/token` | UserAuth | 供第三方免会话调管理接口 |
| CLI Key-创建 | `POST /api/token/` | UserAuth | name, remain_quota, expired_time(-1 永久), unlimited_quota, group, model_limits*, allow_ips；**响应只有 success，不返回 id/key** |
| CLI Key-列表 | `GET /api/token/` | UserAuth | 含掩码 key，需按 name 反查新记录 id |
| CLI Key-取明文 | `POST /api/token/:id/key` | UserAuth+限流 | 返回 `key`（前缀 `sk-`） |
| 兑换码 | `POST /api/user/topup` | UserAuth | `key`→Redeem，成功返回加值后 quota；受站点「支付合规确认」开关整体拦截 |
| 充值信息 | `GET /api/user/topup/info` `/topup/self` | UserAuth | 站内定价/记录 |
| 兑换码管理 | `/api/redemption/*` | **AdminAuth** | 客户端不可查询，只能消费 |
| 状态 | `GET /api/status` | 公开 | 见 B |
| 公告/关于 | `GET /api/notice` `/api/about` `/api/user-agreement` `/api/privacy-policy` | 公开 | 富文本 |
| 三方登录 | `GET /api/oauth/:provider` | 公开 | 真跳转（github/discord/linuxdo/telegram/oidc/自定义） |

统一规则：管理类 `/api/*` 需 `Authorization: Bearer {access_token 或 PAT}` **并附** `New-Api-User: {user_id}`，缺一即 401。

## B. xm.solov.cc 实测开关（2026-08-09 单次探测）

- `system_name=星芒AI`，`setup=true`，`version=v1.0.0-rc.22-solov1`
- 注册：`register_enabled=password_register_enabled=email_verification=true`（邮箱验证码必需）
- OAuth 全关：github/discord/linuxdo/telegram/wechat/oidc/passkey 均 false
- `turnstile_check=false`（当前无人机验证）
- 余额：`quota_display_type=USD`，`quota_per_unit=500000`（50 万 quota = 1 美元），`usd_exchange_rate=7.3`
- `checkin_enabled=self_use_mode_enabled=demo_site_enabled=false`
- `announcements/api_info/faq` 开关 true 但内容为空数组；`uptime_kuma_enabled=true`；`docs_link` 指向飞书文档

## C. 设计约束与坑

1. **创建 CLI key 是三连调**：`POST /api/token/` 不回 id/key → `GET /api/token/` 按唯一 name 反查新记录 id → `POST /api/token/:id/key` 取明文。name 建议带时间戳/uuid 防误取。
2. 漏带 `New-Api-User` 头一律 401，易误判为凭证失效。
3. **登录已非纯 cookie 模型**（rc.22 引入 stateless tokens）：access_token 在响应体、短期有效；refresh 走 HttpOnly cookie。Electron 主进程裸 HTTP 无浏览器 cookie jar，需自行接管 Set-Cookie；旧版 one-api「全程 session cookie」的资料会误导。
4. 余额是整数 quota，必须用当次 `/api/status` 的 `quota_per_unit` 换算，不能硬编码。
5. 实例锁定 rc.22 定制分支、落后上游：新字段/开关以实测为准，不能假设与最新文档一致。
6. 兑换码错误/已用/过期统一同一失败文案，且受「支付合规确认」开关整体拦截。
7. PAT 权限与登录态等同、无独立 scope——不建议长期常驻存储；后台轮询优先短期 access_token + refresh 静默续期（与最初「PAT 存系统凭据」设想有出入，实施前需产品拍板）。

## D. 建议鉴权流

登录 `POST /api/user/login`（Turnstile 按运行时 `/api/status` 决定）→ access_token 存内存/系统安全存储，请求带双头；401 时凭 refresh cookie 静默续期。需要 CLI key 时走三连调，取到明文**立即写入目标 CLI 配置文件**，星芒自身不二次落盘明文（I3 同源原则）。登录方式/验证码开关一律运行时读 `/api/status`；若 OAuth 将来开启，走系统浏览器 + 既有 `xingmang://` 回调协议，不做常驻内嵌 webview。

## 注册方式可用性对照（对齐产品需求）

| 需求 | 现状 | 开通条件 |
|---|---|---|
| 邮箱+密码 | ✅ 已启用（唯一可用） | — |
| 纯用户名+密码 | ⚙️ 后台关 email_verification 即可 | 防滥用能力下降 |
| 微信 | ❌ | 微信开放平台应用申请（有审核周期）+ 后台配置 |
| GitHub | ❌ | 后台配 OAuth App |
| 手机号 | ❌ rc.22 无此能力 | 二开或等上游 |

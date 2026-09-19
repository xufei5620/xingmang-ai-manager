## 用户

- 首次使用引导不再把「Codex 用官方 ChatGPT 账号、但还没登录」当成已连接：这一步会说明还差一次登录，并给出打开工具登录或改用星芒密钥两条路，避免一路点到「完成」后打开 Codex 才发现要登录。
- 注册表单不再拦下账号服务实际接受的用户名：两个字的用户名可以正常注册，只保留 20 位上限。确认密码没填时提示「请再次输入密码」，不再误报两次密码不一致；邀请海报上没带 https:// 的邀请链接也能正确认出邀请码。

## 开发

- `renderer-v2/features/auth/StartGuide.tsx` 补上旧版引导的 `official-login-required` 档：
  `GuideToolState` 新增可选 `officialLoginRequired`，由新导出的纯函数 `guideOfficialLoginRequired()`
  按 `ProviderConfigSummary.codexAuthMode` 判定（只有 Codex 能从配置里读出官方登录态），
  `resolveGuideReadiness` 据此不再把「配置里没有中转 Key」直接当作已连接；`App.tsx` 在拼
  `guideTools` 时填这一字段，连接步的文案与来源标签同步区分（审查总表 R-G7）。
- `renderer-v2/features/auth/state.ts` 的注册校验按服务端实际规则单向对齐：用户名去掉本地
  自加的 3 位下限（new-api `model.User` 只有 `validate:"max=20"`），确认密码区分「未填写」与
  「两次不一致」，`parseInviteCode` 改用旧版 `parseInviteAffCode` 的同一套判定（认 `aff=`、
  `/sign-up`、`/register`，不再要求协议头），并补上 `AffCode` 列宽 32 位的上限校验；
  长度常量与旧版 `src/components/account/validation.ts` 是 I6/I7 下的有意重复，注释互相引用
  （审查总表 R-G10）。旧版渲染层已冻结，本次不动。

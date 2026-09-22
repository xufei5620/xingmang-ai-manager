## 用户

- 软件自带的 AI 对话、生图和生成视频，余额用完时不再说「Key 无权使用」。现在分三种说：余额不足时说「当前账号余额不足，充值后再试就行」，并给一颗「去充值」；这把 Key 设的额度上限用完时说清楚，并给一颗「去调额度」；Key 真的失效时说点「重试」就会自动换一把新的。
- 教程「看到这句提示怎么办」新增「命令行工具里报错」一节，列出余额或额度用完时 Claude Code、Codex、Gemini CLI、Grok CLI 实际显示的原话。特别提醒：Claude Code 在余额不足时也会让你「Please run /login」，**不要照做**，先去充值或调高额度。

## 开发

- 新增零依赖模块 `electron/relay-quota-failure.ts`：`classifyRelayQuotaFailure(status, detail)` 只认服务端写死的句子和错误码，分 `balance` / `keyLimit` / `keyInvalid` 三类，句子逐行对过 new-api v1.0.0-rc.24 与 Sub2API 源码（注释里写了出处）。刻意不认光秃秃的 `insufficient_quota`：上游渠道欠费时中转也会原样转回这个词。5xx、HTML、挑战页不在这里处理。
- new-api 的一个事实：Key 额度用到 0 后，鉴权中间件回的是 401「无效的令牌」，和 Key 被删、过期一字不差；只有剩余额度不够这一次预扣时才是 403 `pre_consume_token_quota_failed`。所以 401 一律归 `keyInvalid`，教程里也照实写「这两种情况报的是同一句」。
- `ai-chat-service.ts` 原来把错误返回体直接丢弃，现在有界读取（沿用 16 KB 上限，超限或不是 JSON 就退回旧文案）后只用来分类，原文不上屏也不进日志；429 的兜底文案去掉了「或账户额度不足」。`ai-image-service.ts` / `ai-video-service.ts` 的 401/403 额度分支改走同一个分类，显示用的 `detail` 仍只取 message，错误码只参与匹配。
- 渲染层：`features/chat/state.ts` 的 `chatErrorMessage` 对这三句原样放行（否则宽泛的「余额」正则会把「额度上限」改回「请充值」），新增 `chatErrorAction`；`ChatPage` 新增可选 `onOpenAccount`，由 `App.tsx` 按 `visibleAccountTab` 跳到充值或密钥页。模块加进了 `scripts/verify-renderer-boundary.test.cjs` 的渲染层可导入名单。
- 教程原文来自沙箱实测：四家推荐版本（Claude Code 2.1.277、Codex 0.155.1、Gemini CLI 0.60.0、Grok 1.0.40）按 `config-files.ts` 的写法配置，指向只监听本机回环的假接口，返回体按 rc.24 源码构造。

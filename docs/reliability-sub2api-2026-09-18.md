# Sub2API 账号数据可靠性修复

日期：2026-09-18。基线：`main@ccf1eab`，客户端 0.2.5。范围为订阅额度、细粒度能力、趋势/任务数据状态、用量筛选契约。

## 锁定接口证据

只读取开源源码，无生产账号、真实 Key、生产业务查询或付费请求。锁定 `Wei-Shaw/sub2api@270eac6973049fe1b50eb75560a74a029e82884c`，与仓库 `docs/DUAL-REALM-IMPLEMENTATION.md` 的既有接口基线一致。

- [订阅 DTO](https://github.com/Wei-Shaw/sub2api/blob/270eac6973049fe1b50eb75560a74a029e82884c/backend/internal/handler/dto/types.go#L748)：`UserSubscription` 的 `daily_usage_usd`、`weekly_usage_usd`、`monthly_usage_usd` 为已用额度；三个限额在关联 `group` 的对应 `*_limit_usd` 字段。`group_id` 不是支付计划 ID。
- [订阅用户接口](https://github.com/Wei-Shaw/sub2api/blob/270eac6973049fe1b50eb75560a74a029e82884c/backend/internal/handler/subscription_handler.go)：`/subscriptions` 返回订阅数组；`/subscriptions/progress` 只返回活跃订阅且会跳过进度读取失败的条目，因此本次不依赖它补造历史订阅或重置时间。
- [周期进度计算](https://github.com/Wei-Shaw/sub2api/blob/270eac6973049fe1b50eb75560a74a029e82884c/backend/internal/service/subscription_service.go#L1121)：各周期限额独立约束；重置窗口还有服务器日历规则，不将月已用当总额，也不把周期相加。
- [用户用量筛选](https://github.com/Wei-Shaw/sub2api/blob/270eac6973049fe1b50eb75560a74a029e82884c/backend/internal/handler/usage_handler.go#L74)：接受 `api_key_id`、`group_id`、`model`、`billing_type` 等；不接受 NewAPI 的 token 名、分组名、请求 ID、上游请求 ID、日志 type。`request_type` 是另一种语义，不等同 NewAPI `type`。
- [日期契约](https://github.com/Wei-Shaw/sub2api/blob/270eac6973049fe1b50eb75560a74a029e82884c/backend/internal/handler/usage_handler.go#L153)：`start_date`/`end_date` 为 `YYYY-MM-DD`，在显式 `timezone` 解析；结束日期加一个日历日形成右开边界，用户选的结束日整天被包含。列表无日期默认不限范围、stats 默认有范围，旧适配会造成列表/统计不一致。
- [看板汇总接口](https://github.com/Wei-Shaw/sub2api/blob/270eac6973049fe1b50eb75560a74a029e82884c/backend/internal/handler/usage_handler.go#L449)：`/usage/dashboard/stats` 只按用户读取全部时间汇总，不解析筛选日期；上游另有 trend/models 接口，本次客户端仍仅接入汇总，明确标注此边界。

抓取的只读源码保存在未跟踪的 `artifacts/sub2api-reliability-source/`；证据引用以上锁定版本，不把源码证据当作当前生产部署验证。

## 实现

- `NewApiSubscription` 添加独立日/周/月 quotaPeriods；总额与已用总额允许 null。Sub2API 不存在可确认的单一总额度，因此两者返回 null。缺失限额为 unknown；上游明确 null/0 的不限额与缺失字段分开；已用 0 保留为确定零值。
- renderer-v2 显示各周期已用、限额、剩余；未知限额显示“限额暂未提供”，不会变成剩余 0。使用 group 名称/ID，不误匹配支付计划 ID。
- capabilities 拆分订阅偏好、在线支付、余额购买、看板、趋势、任务。Sub2API 订阅仍可读取，隐藏不支持的写入口；后端保留 UNSUPPORTED 拒绝。任务 tab 独立使用 supportsTasks，后端拒绝，不再返回伪造空页。
- Sub2API 看板标记 `coverage: all-time-summary`，页面显示“累计汇总 · 全部时间”，隐藏无效时间选择；不显示空趋势/空模型表。失败与有效零值分别保留错误和 0。缺失汇总数值为 PROTOCOL 错误，不默认为 0。
- 用量新增显式日期、IANA 时区、Key ID、分组 ID、计费来源筛选。主进程拒绝不支持字段、错误日期、倒置范围、无效 ID/分页；NewAPI 同样拒绝 Sub2API 专属字段，防止静默扩大查询。
- IPC 参数白名单和校验同步接入这些字段，拒绝日历日期与精确时间混用；已通过 handler 测试确认日期与时区确实跨 IPC 传递，不止是浏览器 fixture 生效。
- 列表与统计始终传同一日期/时区和筛选。默认最近 7 个日历日，页面明确包括结束日全天；首页月/周用量按活动站点使用相应契约。未知 RPM/TPM 为 null。
- 订阅、用量和看板读取失败与有效空结果在实际 renderer-v2 页面分开，畸形响应不会变为空订阅/空调用列表。
- 对 legacy renderer 只做 nullable DTO 的最小兼容，不新增旧界面业务。

## 验证

- `npm run typecheck`：通过完整四段 TypeScript 检查。
- 定向 Vitest：Sub2API、NewAPI、relay contract、日期工具、account context 与 renderer business 共 331 项通过；新增首页双站点用量契约 2 项通过。
- IPC 用量参数 handler：10 项通过，覆盖已有 NewAPI 条件和新增 Sub2API 日历/ID 字段、无效日期与时区、混用语义拒绝。
- `node --test e2e/v2-business.test.mjs`：29/29，通过实际 renderer-v2 BusinessPage。覆盖独立周期、未知限额、不支持的操作与任务隐藏、日期/ID/时区提交、汇总与失败/空结果区分，以及既有支付/订阅/任务/用量业务回归。
- 订阅截图 `artifacts/sub2api-reliability/subscriptions.png` 已人工查看，无字段重叠；全部测试使用隔离 bridge/mock fetch。

限制：未确认生产部署版本与其可用端点；未实现 Sub2API 订阅购买、偏好写入、异步任务或趋势/模型图表。页面和能力声明明确体现这些边界。本轮不发布、不提交、不推送、不操作真实账号。

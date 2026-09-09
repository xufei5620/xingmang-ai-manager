# PR #118：交付与接续索引

核对日期：2026-09-09。

本次记录只核对已提交源码与交付物的关系，不代表执行了新一轮功能测试。所有相关实现继续集中在 PR #118 的 `chore/dual-site-phase0-20260908` 分支；不合并、不发布、不请求生产账号或执行真实付费生成。

## 已入库基线

核对时最新实现提交为 `1088c471f4e595bf7a109a0690f4a68def344049`，父提交为 `ff09c073cc56d11d10227b59245865e3d2e6c8de`；PR 相对 `main@ec26b3300255a27afb8450de9488d9d88dea7eea` 有 4 个提交、22 个改动文件。上述计数是本索引提交前的快照，不是永远固定的当前值。

实际模块和验证边界以 [DUAL-REALM-IMPLEMENTATION.md](./DUAL-REALM-IMPLEMENTATION.md) 与当前分支源码为准。PR 描述、聊天记录和附件不能替代源码 HEAD。

| 范围 | 已在分支中的实现 | 未完成部分 |
|---|---|---|
| 兼容保护与 xm Runtime | 严格站点解析、旧 `sub2api` ID 保护、SiteRuntime、BackendRegistry、ActiveIdentity、main 装配 | 目前仍为 xm-only 应用运行时 |
| 资产响应 | 独立 `ai-asset-protocol.ts`、测试及缩略图版本更新 | 不能据此认定全业务或全存储已经完成账号域隔离 |
| 双账号域核心 | `realm-account.ts`、`realm-account-vault.ts`、`realm-account-vault-file.ts`、`realm-switch-coordinator.ts`、`new-api-realm-backend.ts` | 新协调器尚未替换旧 main/IPC 入口，真实任务 quiesce 和 CLI 切换事务未接入 |
| sub2api | `sub2api-account-client.ts` 及测试，身份、余额与 Key 子集 | 生产部署契约、验证码/2FA 交互、完整计费/用量/订阅/公告等未完成 |
| 能力呈现 | `realm-capabilities.ts` | 登录选站和真实页面组件尚未挂载 |
| 验收 | 实施记录保留上一轮局部类型检查与 91 项离线断言的报告 | 不是全仓 Vitest/CI 通过；完整构建、系统加密、文件系统与 Windows/macOS 验收待完成 |

## 附件不能直接覆盖仓库

历史附件 `xingmang-pr118-wave3.zip` 是另一份离线实现交付，不能认定它与已提交的 Wave 3 逐文件相同。例如附件使用 `account-realm-contract.ts`、`realm-vault-files.ts`、`realm-business-context.ts` 和 renderer 的呈现模块，当前分支则使用 `realm-account.ts`、`realm-account-vault-file.ts`、`new-api-realm-backend.ts` 和 `realm-capabilities.ts`。

两份实现还存在同名的 `realm-account-vault.ts`、`realm-switch-coordinator.ts` 与 `sub2api-account-client.ts`。禁止整包覆盖、重复叠加累计补丁，或把附件的 108 项测试报告直接当作当前分支的测试结果。缺失能力应基于当前源码逐项整合并重新验证。

同理，早期 Wave 1/2 补丁不应重新覆盖已经抽取为独立模块的资产协议代码。后续增量应明确其父提交，并在推送前检查分支是否前进；不得强推覆盖他人的工作。

## 下一步门禁

1. 将新协调器接到受信 IPC 与主进程装配，保持当前账号、请求地址、凭据及 epoch 一致。
2. 对既有 Key、聊天、画布、资产、缩略图、订单等 store 和全部业务消费点逐项完成账号域隔离；旧数据迁移可恢复且保留原数据。
3. 接入真实任务停止/等待、CLI 的 URL+Key 原子写入与重启提示，明确客户端取消不等于服务端撤销计费。
4. 核对 api 部署契约后再扩大适配能力，未知客服、协议、支付、模型分组不回退到 xm。
5. 挂载实际登录选站与能力界面，并在项目锁定依赖环境执行全仓检查和双平台验收。

在这些门禁完成之前保持 PR 为 Draft、api 生产入口关闭。源码成功提交不等于功能完成，也不等于允许发布。

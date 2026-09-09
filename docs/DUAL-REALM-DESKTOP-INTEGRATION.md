# 双站桌面接线（2026-09-09）

本记录描述 PR #118 本地合入后的真实桌面接线，替代 Wave 3 文档中的“尚未挂载 main/IPC/UI”状态。此次本地实现不包含远程合并或发布。

## 登录与账号归属

- 注册、邮箱注册验证码、注册后自动登录固定使用 `xm.solov.cc / new-api`。
- 客户界面统一为“星芒账号”，不显示平台选择器、后台名称或账号域名；内部仍用 `solov`（xm/new-api）和 `solov-api`（api/sub2api）隔离数据。
- 普通登录不传站点，由主进程优先使用该登录名上次成功的归属；无记录时优先 new-api，只有明确的账号密码拒绝才尝试另一后台。非邮箱用户名只验证 new-api。网络、验证码/2FA、资料查询失败或磁盘提交失败均不触发换后台。
- 同一邮箱和密码在两站均有效时，使用上次成功的归属；首次使用 new-api。账号切换列表用中性账户尾号区分两个记录，不暴露后台信息。
- 相同邮箱、相同数值 userId 在两站仍是两个账号。会话、聊天、头像、Key、画布项目、运行记录、资产和缩略图按账号域隔离。
- 历史 `relaySiteId='sub2api'` 保持 xm 别名，不重新解释为 api 账号。

## 主进程运行时与存储

`realm-account-service.ts` 是 main/IPC 的活动账号入口。新候选使用独立真实客户端完成登录/恢复；vault 原子写入账号和活动指针成功后同步晋升该客户端，不再重复调用 new-api restore 消耗 refresh cookie。

`realm-accounts-v2.dat` 使用 Electron safeStorage 与 safe-local-data 原子写入。旧 saved-accounts/session 文件仅在首次迁移读取；迁移标记和活动账号一起提交，旧文件保留，之后退出或移除账号不会重新导入。加密不可用、basic_text 或磁盘错误会拒绝持久登录，不明文降级。

统一登录新增最多 64 条登录归属提示，与成功账号和活动指针一起原子提交；只含规范化登录名、账号域和 userId，不保存密码或 token。退出后可保留路由偏好，但不能凭此恢复登录。统一“记住账号”仅从最近成功身份对应的加密凭据库预填，标识不匹配时留空。

刷新凭据按原有账号记录更新，不移动活动指针；new-api 和 sub2api 都在后续用户资料请求失败时保留已轮换凭据。过期响应和错误有全局 revision 守卫。

账号切换先阻止新业务并取消、等待当前聊天/图片/视频/画布任务及完整 IPC 处理器收尾，再认证和提交。等待取消不代表撤销已经发生的服务端生成或计费。外部已运行的 CLI 继续使用它们已加载的配置，客户端不承诺热切换；账号列表提供可选的 CLI 配置同步。

xm 的既有文件根保持兼容；api 使用固定 `realms/api-account` 子目录。画布即使选中相同工作文件夹，api 素材也使用该文件夹内独立的账号域目录。旧 v2 聊天记录只迁入相同 xm 账号，原记录保留。

## Sub2API adapter 与实际能力

接口以用户提供的 sub2api 源码中的 router 与 frontend API 调用为准，不采用过时 handler 注释：

| 功能 | 接口 |
|---|---|
| 登录、恢复与续期 | `/api/v1/auth/login`、`/auth/me`、`/auth/refresh` |
| 用户资料 | `GET /api/v1/user/profile`、`PUT /api/v1/user` |
| 修改密码 | `PUT /api/v1/user/password`，成功后清除本机会话并重新登录 |
| Key 列表/创建/读取/更新/撤销 | `/api/v1/keys`、`/keys/:id` |
| 用户可用分组 | `GET /api/v1/groups/available` |

`sub2api-relay-backend.ts` 实现 RelayBackendClient。共享 DTO 中保留旧字段名，但 api 金额始终使用原生 USD，`quotaPerUnit=1`；有限 Key 额度保留小数，不能把 `$0.25` 取整为 `0`（不限额）。创建和更新操作不自动重放不明确的请求。

自动 CLI Key 匹配用户可见的活动分组，遍历全部 Key 分页，按名称与分组精确复用，并串行处理并发创建。分组不存在或存在歧义会明确失败。

| 场景 | api 分组 | 默认模型 |
|---|---|---|
| Codex / 初始聊天 | `Codex_pro` | `gpt-5.6-sol` |
| Claude CLI | `Claude-MAX(不限客户端)` | 从该组真实模型列表选择 |
| Gemini CLI | `Gemini` | 从该组真实模型列表选择 |
| Grok CLI | `grok-heavy` | 从该组真实模型列表选择 |
| 画布图片 | `GPT-image2` | `gpt-image-2` |
| 画布文本 | `Gemini` | `gemini-3.7-flash` |
| 画布视频 | 空 | 空；主进程拒绝 api 视频生成 |

xm 原有分组和默认值保持原样。模型查询和配置写入使用活动账号的固定站点；旧 CLI Key 的实际 URL 与当前站点不一致时，拒绝拿它探测新站点。

分组下拉直接读取当前账号可用分组：密钥新建/编辑、聊天，以及画布的图片/文本/视频分组在打开下拉、重新进入相关页面或窗口恢复可见时刷新；相关界面在前台时每 30 秒同步。刷新请求会去重，不轮询隐藏页面，也不因后台同步重新准备 Key。有效的选组、模型和草稿保留；失效分组显示不可用，要求明确重选。聊天刷新按钮同时重新获取分组与当前组模型，密钥弹窗提供独立刷新按钮。这里是按操作触发和定时同步，并非服务端推送。

刷新改动验证：`npm run test:v2` 的 127 项单测和 100 项浏览器检查通过；画布 508 项通过；类型检查与画布构建通过。`node e2e/canvas-group-refresh.mjs` 用本地 mock 宿主真实点击图片、视频、文本下拉，验证更新、移除分组、失败重试、保持草稿及避免无关 Key 准备和生成。

尚未支持的 sub2api 用量/账单/订阅/邀请/设备会话/公告/法律文档/客服入口由能力投影隐藏，主进程方法也明确拒绝。没有把零值占位展示为真实用量。2FA 与交互验证码仍需独立流程，此版本会明确拒绝而不绕过。

## 本地验证与边界

统一登录入口更新：类型检查与构建通过；全量 Vitest 3382 通过，仍为 4 个既有 EPERM 失败。登录/IPC 定向回归 669 项、归属提示 22 项通过；renderer-v2 127 项单测通过。浏览器 92 项中唯一的旧标题断言已随新文案修正，所属头像/账号页 5 项复跑全部通过。隔离 Electron 报告新增 `automaticDetection`、`rememberedRouting`、`lastSuccessPreference`、`platformDetailsHidden` 均为 true；开发窗口已重启到新版主进程。

此前双站接线记录：TypeScript 与编译通过；全量 Vitest 3325 通过、160 跳过、4 个既有 Windows EPERM 失败；renderer-v2 127 项单测及 91 项浏览器检查通过；画布 499 项通过；Node/UI 套件通过。最后新增的刷新竞态和 IPC 校验在 384 项定向回归中通过。Electron 双站端到端报告保存在 `output/realm-account-review/result.json`。

- 项目 TypeScript 检查、renderer-v2/canvas 编译与相关 Vitest 回归。
- Node/UI 交互套件，以及 renderer-v2 登录、账号切换、资料、小数额度、密码、聊天兼容和能力隐藏测试。
- vault 真实临时文件读写、同号分域、错误回滚、迁移标记、basic_text 拒绝测试。
- `node e2e/realm-account-smoke.mjs`：使用真实编译后的 Electron/main/preload/IPC/UI，隔离 userData，默认拒绝网络的 mock 后端与测试 AES cipher，验证两站登录、同号双记录、自动 Key 缓存分域、双向切换、重启恢复及退出不复活。截图保存在本地 `output/realm-account-review/`。

完整 Vitest 的本机已知基线是 4 个 Windows 符号链接权限失败（EPERM）；未放宽这些安全断言。macOS 原生运行和真实 DPAPI/Keychain 验收不以 mock cipher 通过代替。本轮未执行真实付费生成。

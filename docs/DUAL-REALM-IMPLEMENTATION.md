# 双账号域实施记录：PR #118 · Wave 3

> 接续更新：main/IPC、账号选择 UI、RelayBackend adapter 与 vault 已在本地接通，最新范围和验证边界见 [双站桌面接线](./DUAL-REALM-DESKTOP-INTEGRATION.md)。下文保留为 Wave 3 历史记录。

状态：**可测试的主进程核心模块已完成；应用端到端接线未完成；仍为 Draft，禁止据此发布。**

基线：`ff09c073cc56d11d10227b59245865e3d2e6c8de`。
用户已授权所有相关工作提交同一 PR #118；不合并、不发布、不请求生产账号、不执行真实付费生成。

## 本批代码

| 模块 | 实际实现 | 边界 |
|---|---|---|
| `electron/realm-account.ts` | 中立身份、固定账号域、凭据判别联合、严格解析、无凭据摘要 | 新类型不直接跨 IPC 导出；`sub2api` 旧 ID 仍为 xm |
| `electron/realm-account-vault.ts` | 串行化的加密文档、账号/活动指针一起原子写入、同 ID 分域、限额、迁移、退出与忘记分离 | 不自动扫描/迁移旧文件；旧文件保留 |
| `electron/realm-account-vault-file.ts` | 用既有 safe-local-data 原语和系统加密接口绑定新的 `realm-accounts-v2.dat` | 尚未在 main 装配；拒绝 basic_text；本地未验证真实文件系统或 safeStorage |
| `electron/realm-switch-coordinator.ts` | prepare/commit 切换、失败保留旧账号、互斥、恢复、epoch、取消、过期值/错误丢弃 | 必须接入真实 quiesce；取消不等于服务端撤销计费 |
| `electron/new-api-realm-backend.ts` | 隔离候选客户端桥接，不调用当前活动客户端的登出或持久化回调 | 只桥接身份；不是所有 new-api 业务方法的替代 |
| `electron/sub2api-account-client.ts` | 普通用户登录、恢复/一次刷新、余额、Key 列表/显式读取/创建/撤销；固定 origin、超时、字节上限、重定向拒绝、无 cookie | 依据上游固定提交，不代表 api.solov.cc 部署已验证；2FA 返回明确不可用而非绕过 |
| `electron/realm-capabilities.ts` | 已核实能力与产品政策取交集；api 注册始终禁止；账号页显示模型 | 目前只是 UI 投影函数；并非已经挂载的界面或主进程授权边界 |

## 本批验收证据

- 91 项测试断言通过，0 失败：身份/存储/切换/能力/桥接/sub2api/整合工作流。
- 测试源使用 Vitest 的 describe/it；离线运行仅把测试副本 import 替换为 node:test，断言与被测实现不变。**不是项目 Vitest 运行结果。**
- CommonJS/Node 与 ESNext/bundler 两种严格局部 TypeScript 检查通过。
- 离线检查不包含 `realm-account-vault-file.ts` 对真实 safe-local-data 的执行；该文件在完整仓库检查/原生文件系统验收前不能标记验证完成。
- 本地原生 fetch、HTTP(S)、TCP、TLS 在运行器中阻断；sub2api 只使用显式注入的 mock fetch。
- 使用环境：Node 22.16.0，TypeScript 5.8.3。未安装项目 lockfile 依赖；与项目 TypeScript 5.7 门禁不同。
- 当前容器不能解析 github.com，因此完整 clone、npm ci、全仓 typecheck/test/build 未完成。源码读取与提交通过 GitHub 连接器。

## 上游接口事实（不是生产侦测）

锁定 `Wei-Shaw/sub2api@270eac6973049fe1b50eb75560a74a029e82884c`。

- `frontend/src/api/url.ts`：默认 `/api/v1`。
- `frontend/src/api/auth.ts`：`POST /auth/login`、`GET /auth/me`；2FA 独立流程。
- `frontend/src/api/tokenRefresh.ts`：`POST /auth/refresh`，body 为 `refresh_token`，会轮换 token。
- `frontend/src/api/client.ts`：`{code:0,data:...}` 成功外壳。
- `frontend/src/api/keys.ts`：`/keys` 的分页、创建、读取和 DELETE。
- `frontend/src/types/index.ts`：用户安全整数 ID、balance、Key 的 user_id/group_id/key/status。

源文件入口：https://github.com/Wei-Shaw/sub2api/tree/270eac6973049fe1b50eb75560a74a029e82884c/frontend/src

保守处理：余额保留 `sub2api-balance` 原生单位，不伪造成 new-api quota，也不展示未经部署确认的货币换算；Key 列表绝不返回 key 明文；不自动重试可能已经成功的写操作；服务器错误原文不回显。

## 尚未完成：不能把核心模块当成产品完成

1. **IPC 与主进程装配**：现有 main/ipc 仍使用 xm-only Runtime；新协调器未成为唯一活动身份。要先接入 sender 校验、能力执行门禁、最后一次 await 后的所有权复查，再替换旧账号 handler。
2. **真正的存储迁移**：新账号库可用，但 ChatKey/ManagedCliKey、画布项目/运行/媒体/缩略图、聊天记录等既有 store 尚未全量改为 realm scope。需复制式迁移与中断恢复，不能按全局 userId 继续访问第二站点数据。
3. **全业务路由**：聊天/图片/视频/画布/CLI/订单/支付/客服/法律/公告/邀请/模型与分组预设的固定上下文尚待全接。api 的客服、协议、支付和能力配置未知时保持不可用，不继承 xm。
4. **CLI 切换事务**：quiesce 只是强制接线入口；真实外部 CLI 检测、重启提示、URL+Key 原子写入及备份回滚还没接入。不能认为改文件后已运行的 CLI 自动热切换。
5. **sub2api 完整能力**：当前为身份、余额和 Key 子集。不是现有 RelayBackendClient 全量实现；后台金额语义、分组权限、自动签发策略、用量/支付/订阅/法律/公告以及验证码与 2FA 交互仍待部署契约确认和相应测试。
6. **界面**：登录页选站、账号切换列表、恢复失败说明、能力隐藏组件还没挂载。新增 UI 投影不等于界面完成。
7. **完整验收**：项目锁定依赖下 typecheck、Vitest、Node/e2e、canvas、compile、Windows/macOS、升级/降级、磁盘满、系统加密不可用、真实无付费测试账号仍待验证。

## 切换的精确定义

新协调器只处理客户端事务。准备阶段阻止新业务请求，并调用宿主 quiesce；认证使用不触碰当前客户端的候选会话。持久化活动账号成功后才发布内存状态。失败后旧账号记录不删除，但 epoch 不回退，因此旧回调不会复活。

服务器已经轮换 refresh token、已经执行生成或已经扣费时，客户端无法撤销这些远程事实。刷新成功后持久化失败等情形可能需要重新登录，不能承诺“原密码/旧 token 一定继续可用”。对外部 CLI、跨文件配置与账户指针，还必须另外实现可恢复事务；本批未声称完成。

`execute()` 返回带归属的结果；调用方须在真正发送 IPC 或写文件之前调用 `assertCurrent(result)`，之后不能再 await。它不是 renderer 能伪造的授权令牌；原有受信 sender、输入校验与服务端鉴权不变。

## 下一次接续

只在 #118 同一分支继续。先读取当前 head 与本台账，不重复应用 Wave 1/2 累计补丁。保持 api 生产入口关闭，直到身份、存储、业务路由和界面四层都接通并有测试证据。

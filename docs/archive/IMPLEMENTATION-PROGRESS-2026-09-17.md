# 2026-09-17 需求实施与复核记录

2026-09-18 后续用户要求的 8 项业务正确性/数据可靠性修复正在进行，当前唯一进度来源为 [RELIABILITY-FIXES-2026-09-18.md](RELIABILITY-FIXES-2026-09-18.md)。下方 D/C/B 为此前已完成或已明确边界的工作，不要重做。

2026-09-19 按用户要求，Claude Desktop 已改用开发模式中的本地第三方推理配置。下方 B4/B6/R4 的注册表与导出方案保留为历史记录，已由 [当前本地配置契约](EXTERNAL-CLIENT-CONFIG.md#claude-desktop) 替代。

## WorkBuddy 桌面配置契约纠正（2026-09-18）

真实安装的 WorkBuddy 5.5.6 桌面模型页使用 `%USERPROFILE%\.workbuddy\models.json`，此前写入用户 `.codebuddy/models.json` 是桌面未加载的直接原因。安装包源码同时支持顶层数组和 `{ models, availableModels }` 对象；新文件采用桌面 UI 的数组格式，已有对象结构、模型和未知字段增量保留。原 `vendor: "OpenAI"` 并非格式无效，新模型改用自定义供应商的 `Custom`，已有 vendor 保留。

下方 B3/B6 和历史运行时报告记录的 lite-wb 2.151.0 本地 mock 结果保留，但不能作为桌面配置路径或桌面加载的验收。当前桌面契约依据为 [已安装应用源码记录](../artifacts/workbuddy-model-contract-2026-09-18/report.md)，没有据此宣称真实星芒模型调用通过。

保存后应重新进入 WorkBuddy 模型设置页确认模型；必要时由用户重启客户端，工具不自动结束会话。已打开设置页不会直接响应文件同步事件，写后回读仅证明目标文件有效。此次纠正不改写历史测试结果，后续实现与验收进度继续记录在上方唯一进度来源。

## D：WorkBuddy 安装源连接失败（2026-09-18 已完成）

用户真实安装日志：`Tencent.WorkBuddy` 经 winget 更新源失败，`InternetOpenUrl() failed`、`0x80072efd`（2147954429），尚未进入安装器。C 项仅 mock 安装验证，不能覆盖此真实网络失败。

| 小项 | 状态 | 完成标准 |
| --- | --- | --- |
| D1 确认故障与下载来源 | 完成 | 官方 5.5.6 EXE 完整下载 532127544 字节，SHA-256 与微软清单一致、腾讯 Authenticode Valid；官方 CDN 可达，不同网络栈到 winget CDN 结果不同，未改系统网络设置；证据 artifacts/workbuddy-source-audit-2026-09-18/report.md |
| D2 官方包恢复路径 | 完成，隔离测试通过 | 固定腾讯官方包、15 分钟/1 GB 有界下载、禁止重定向、逐块写入、完整哈希与签名、执行前复核、用户级静默安装；受保护模式沿用可信暂存；清理失败不覆盖主结果 |
| D3 安装流程与错误提示 | 完成，隔离测试通过 | 明确网络 HRESULT 才恢复；排除取消/超时/终止/已启动安装器；切换前复检；积累分块输出但先匹配再裁尾，避免漏掉启动标记；保留内部诊断与中文原因 |
| D4 验证与开发窗口 | 完成 | 改前 runtime/service 70/70；最终 installer/runtime/service 136/136，工具浏览器 10/10，完整 typecheck/compile 通过；实际恢复安装 WorkBuddy 5.5.6 成功；08:43 最终开发窗口已重启置前，真实界面显示工具行与配置入口 |

分工：clients 实现独立 WorkBuddy 官方安装模块与隔离测试；startup 只读核实网络/来源/参数；主代理接入 runtime、错误分类、整合测试与本机验证。保留 C/B 已完成实现，不重复模型协议审计；不 commit/push/发布，不改生产 Key。

D 项真实首次安装：winget 同样返回 0x80072efd，恢复路径成功启动官方下载，但哈希校验拒绝了响应，未执行安装器。进一步完整下载核对，腾讯同一 URL 实际返回两份 WorkBuddy 5.5.6，分别 532127544 / 532166536 字节；Windows 均验为有效腾讯签名，证书指纹不同。现保持微软清单哈希，并增添独立验真的现行 CDN 哈希 `0be18472b3c1d4cdbbe977784c09736bd96e641e30901ac22ccd4a8ee8f54303`。未知哈希与无效签名仍被拒绝，新增测试后 129/129 通过。首次失败日志/JSON 保留为 `artifacts/task-d-first-install.log`、`artifacts/workbuddy-install-first-attempt-2026-09-18.json`；两包来源证据为 `artifacts/workbuddy-source-audit-2026-09-18/binary-comparison.json`。

D 项实际安装：2026-09-18 08:29:53 开始，真实 winget 再次返回 0x80072efd，随后自动从腾讯下载，通过双重哈希检查和有效腾讯签名检查，执行用户级静默安装，最终复检成功。版本 5.5.6，路径 `C:\Users\peaker\AppData\Local\Programs\WorkBuddy\WorkBuddy.exe`；08:34:47 独立只读扫描确认 installed/running/launchSupported 均为 true、detectionError 为 null。记录为 `artifacts/workbuddy-install-result-2026-09-18.json` 与 `artifacts/task-d-real-install.log`。本轮未写模型 Key、未调用生产模型。

D 项暂存生命周期追加已完成：实际安装器自动启动了 WorkBuddy，应用继承了安装暂存 TEMP/CWD，导致清理与运行期写入冲突。普通用户安装现使用验证后的正常用户临时目录和 System32 工作目录，过滤大小写形式的临时环境变量覆盖；受保护模式继续保持可信解压边界。默认清理仅删除本次创建且身份未变的安装 EXE，再以 rmdir 移除空目录，保留应用运行文件。新增回归覆盖运行文件持续可写、两种权限模式保留客户端文件、文件/目录被替换时拒绝删除、reparse 临时目录拒绝和清理诊断失败。安装模块 49 项、整合 installer/runtime/service 136 项均通过。该追加修正没有重装现有客户端，也没有停止其运行。

D 项最终检查：136/136 定向测试、完整 typecheck/compile、工具浏览器 10/10、50 个修改/未跟踪文本文件 UTF-8 无 BOM 均通过；日志为 `artifacts/task-d-final-tests.log`、`artifacts/task-d-final-typecheck.log`、`artifacts/task-d-final-compile.log`。未重跑全仓全量测试，B7 中 Windows symlink EPERM 仍是最近全量记录。两份来源审计安装包约 1 GB 的清理命令被自动审批策略拦截（未提供更具体原因），文件保留在 `artifacts/workbuddy-source-audit-2026-09-18`；这与已清理的实际安装下载包不同，不影响安装成功。

D 项最终开发界面：前一开发实例已停止，最终服务 session 78212、Electron PID 73952，Vite `http://127.0.0.1:5173/`，主进程 watch 0 错误。08:43 Computer Use 已激活唯一开发窗口，可访问性树再次确认“你的工具”中 WorkBuddy v5.5.6 运行中/配置、Claude Desktop v2.2553.0.0 运行中/配置，“还可以装”中 OpenCode 安装入口。Claude 版本变化来自本机已有客户端，本轮未更新 Claude。最终实例已加载暂存生命周期修正，服务保留供用户使用；原生检查为只读可访问性验收，交互证据来自已通过的浏览器测试。

## C：三个客户端纳入完整工具管理（已完成）

用户要求 WorkBuddy、Claude Desktop、OpenCode 与其他工具一样列在工具区，支持一键安装、配置、打开和状态检测。沿用 B 项配置实现，不重做已通过的工作。

| 小项 | 状态 | 完成标准 |
| --- | --- | --- |
| C1 原生安装来源与能力 | 完成 | 官方 winget ID：Tencent.WorkBuddy、Anthropic.Claude、SST.OpenCodeDesktop；本机 winget 可用，Claude Store 已安装，OpenCode CLI 不算桌面安装；macOS 暂仅检测/打开，完整来源与签名证据在 artifacts/external-client-install-sources.md |
| C2 原生生命周期 | 完成，37 项测试通过 | 独立 runtime、官方包安装、共享安装队列、防重复、进度、安装后再检测、可信 Explorer 启动；修复 WindowsApps 根目录 realpath 权限导致的 Claude 误报及无关安装记录拒读拖累全体检测；真实只读 scan 约 1.1 秒识别 Claude 2.110.1.0，三个客户端无检测错误 |
| C3 工具区统一呈现 | 完成 | 同一 ToolRow/已装与可安装分组、安装/配置/打开动作与状态；去掉三个顶部独立按钮；账号 scope 失效保护；Codex 非 GPT 入口归入 Codex 工具行；计数同步；84 项 App 浏览器测试与原型双主题 6 条流程通过 |
| C4 IPC 与配置状态 | 完成，定向测试通过 | 三个生命周期 IPC、严格 ID 校验、账号恢复门禁、进度转发、真实配置摘要不含 Key；含 runtime/config/service/IPC/preload 的 6 文件 436 项通过 |
| C5 验证与开发窗口 | 完成 | typecheck、compile 通过；v2 单测 257/257，App 84/84、其他浏览器 90/90、加速页 9/9；现有服务与安装回归 124 通过/55 平台跳过；UTF-8 与 diff check 通过；19:59 新开发窗口置前，真实可访问性树确认 Claude 配置行、WorkBuddy/OpenCode 安装行 |

分工：clients 负责原生生命周期独立模块；startup 核实官方安装来源与平台行为；models 负责 v2 工具行/交互；主代理负责契约、IPC、配置状态与整合验收。代码 UTF-8 无 BOM，保留既有未提交文件；不 commit/push/发布。

C 项验收说明：安装与打开过程使用隔离 mock 测试，未在这台机器新装 WorkBuddy/OpenCode，也未重新安装 Claude；真实机验证覆盖只读检测，不能据此宣称真实安装和生产推理已经验收。Windows 使用真实 winget 安装实现，macOS 自动安装尚未实现并在行内说明。原型仅离线演示，不执行安装。

C 项独立复核追加：安装记录枚举现在按根目录/条目隔离失败；已验证的客户端保留可打开状态，尚未找到的客户端在清单不完整时报告检测错误，避免误装。新增测试用真实 PowerShell 执行生产 inventory 脚本，并用隔离 mock 模拟无关注册表项拒读，断言 Claude AppX 保留且 WorkBuddy 不错误进入安装。37/37 runtime 通过；修复后再次 typecheck/compile/本机只读 scan 通过。

C 项浏览器回归发现先前 lazy 优化后，加速页测试冻结时钟导致 Suspense 不显示。已用独立脚本复现（冻结时页面数量 0，推进 500ms 后 1），测试在首次加载/刷新后等待模块响应并推进时钟；原有倒计时断言未放宽，9/9 全过。首次失败与后续结果记录在本轮日志；其他浏览器 90/90、App 84/84，共 183 项通过。未重复整仓全量 Vitest，B7 的 4 个 Windows symlink EPERM 仍是最近全量记录。

C 项最终开发实例：`npm run dev` session 11771，Electron PID 16464，Vite `http://127.0.0.1:5173/`，主进程 watch 0 错误。20:05 已在安装记录错误隔离修复后重启，旧实例已停止，新实例保留运行。Computer Use 已激活唯一开发窗口；真实首页“你的工具”中 Claude Desktop 2.110.1.0 显示运行中/配置，“还可以装”中 WorkBuddy 和 OpenCode 均显示安装；Codex CLI 行显示“非 GPT 模型”。只读树检查不等同原生点击验收，交互证据来自隔离浏览器测试。

## 续作：四个入口已补齐，首屏加载优化已实现

用户再次指出四项全部不可见。本轮优先完成 R2–R6 的界面与配置链路，并量化首屏代码按需加载；R1 的整机冷/热启动仍待测。

| 小项 | 状态 | 实现与检查 |
| --- | --- | --- |
| B1 首页入口 | 已实现，浏览器验证通过 | `renderer-v2/features/tools/ClientConnections.tsx` 四个显式按钮，挂在 v2 Home 的“客户端与模型”；新增 ExternalClientDialog 选择已有/账号/手填密钥并检测模型 |
| B2 Codex 非 GPT | 已实现，45 项工具模块测试通过；真实 CLI 3/4 隔离场景通过 | 模型列表筛选与保存约束；保持 Responses；CLI 非 GPT ID 流式、HTTP 错误、应用层取消通过；工具协议回传成功但本机策略阻断命令，完整工具执行未过；生产兼容未验证 |
| B3 WorkBuddy/OpenCode | 已实现，47 项配置测试通过 | 腾讯 models.json；OpenCode JSONC 优先级/默认模型/SDK；复用原配置事务与并发检查 |
| B4 Claude Desktop | 已实现，19 项隔离测试通过 | 官方 gateway 用户策略，HKLM 覆盖检测、备份、回读；非 Windows 导出官方 JSON，不猜内部文件 |
| B5 主进程链路 | 已接线，定向测试通过 | IPC 验证凭据来源/账号归属；保存前重新检测模型权限；固定当前站点 URL；写入排队，Key 不回传；24 项 service 集成测试通过 |
| B6 UI/真实客户端验证 | 浏览器回归、OpenCode CLI 4 场景、WorkBuddy 官方运行时 2 场景通过 | 首页逐一打开/失败重试/保存；深浅主题截图检查；原型集成 13/13；真实 OpenCode 1.18.31、腾讯 lite-wb 2.151.0 与 localhost mock 完成流式及 read 工具回传；Claude 注册表仅只读探测，未验证生产推理 |
| B7 四入口最终验证 | 完成，完整套件的失败已记录 | typecheck、compile、UTF-8 通过；9 文件 468 项定向测试；v2 252 单测/177 浏览器通过；scripts 124 通过；旧 UI 62 通过；全量 4 个 EPERM 与账号用例首次超时见下；新 `npm run dev` watch 0 错误，原生可访问性树确认首页四个按钮；性能修改后类型/编译与 78 项 App 回归再次通过 |
| B8 首屏加载优化 | 已实现，量化/导航/78 项 App 回归通过 | App 中聊天/业务/加速页按路由 lazy 加载；初始 JS 832,414 → 668,193 bytes（减少 19.73%），模块 438 → 400；6 次隔离浏览器页面可见中位数 322.75 → 307.85 ms，仅 renderer 本地 mock 诊断值；页面保活/账号隔离/按需请求验证通过，整机冷启动仍未量化 |

恢复工作时先看上表与代码，不重复下文 A1–A8 审计。并行分工：clients 维护 external-tool-config 与原型；startup 维护 claude-desktop-config；models 维护 ConfigDialog/model-filter 并核实真实 OpenCode；主代理维护 Home/App/ExternalClientDialog/IPC/service/整合测试。

本轮真实界面检查：已激活新启动的 Electron 开发窗口，原生可访问性树包含首页“客户端与模型”及四个按钮。Computer Use 截图接口报 `SetIsBorderRequired failed: 不支持此接口 (0x80004002)`，改用只读可访问性检查成功；点击接口报 `coordinate input geometry is unavailable`，因此不把原生点击称为通过。四入口打开、保存及失败重试的交互证据来自真实 v2 App + mock bridge 浏览器测试。

WorkBuddy 工具能力补证：官方 `@tencent-ai/codebuddy-code@2.151.0` 的 `codebuddy-lite-wb.mjs` 仅在 `supportsToolCall === false` 时移除 `tools/tool_choice`，编辑器以 `!== false` 初始化。当前写入器不强行设置该字段，缺省不会禁用工具，已有显式 false 被保留。

本轮完整 `npm test` 的 Vitest 阶段：309 文件通过、3 文件失败、3 文件跳过；4161 项通过、4 项失败、162 项跳过（4327 总计）。4 项失败均为 Windows 创建符号链接的 `EPERM`，涉及 backups/path-identity/safe-local-data，与此前记录的失败项一致；本轮没有重新建立干净基线，不宣称整套全绿。该阶段使命令提前结束，`npm run test:node` 已单独启动以补齐后续检查。日志：`artifacts/final-npm-test.log`。

`npm run test:v2` 完整通过，含 34 文件 252 项单测和 177 项浏览器测试。单独 `test:node` 的 124 项脚本测试通过，账号/维护 20 项首次为 19 通过、1 个 `输入兑换码` 定位超时；该单项独立复跑通过（约 4.9 秒），保留首次失败记录，不假称从未失败。因该失败使后续 UI 脚本没有自动执行，另外运行 `npm run test:ui`，62/62 通过。

真实客户端隔离报告：`artifacts/opencode-client-audit-report.md`、`artifacts/workbuddy-client-audit-report.md`。WorkBuddy 验收的是官方包的 lite-wb 运行时，未验收桌面窗口；新建配置和已有 Anthropic vendor 配置增量合并两场景均退出码 0，携带工具定义并回传隔离文件内容。所有模型请求只发 localhost，真实上游、账号模型权限和桌面 UI 未在这些报告中宣称通过。

首屏量化产物为 `artifacts/startup-audit/{before,after,navigation}.json`，同条件生产构建与真实 v2 App 的隔离浏览器 fixture。现有账号恢复和 Windows 安全探测顺序保持；没有用此页面测量宣称整机冷启动改善。优化后完整类型检查和生产编译再次通过。最终开发窗口已重启并置前，2026-09-17 18:37 原生可访问性检查确认首页四入口，Vite `http://127.0.0.1:5173/`、Electron PID 44720、watch 0 错误；开发服务留给用户试用。

Codex 真实 CLI 隔离报告：`artifacts/codex-non-gpt-client-audit-report.md`。官方 0.153.4 按当前模板发送 `deepseek-v4-flash`、`/v1/responses`、`stream:true`，完成流式回合；HTTP 400 与 app-server 应用层取消通过。工具调用返回 `function_call_output`，但只读命令遭本机执行策略阻断，完整断言失败；取消不会立即释放 HTTP。请求还包含 `reasoning.effort=xhigh` 和 `summary=auto`，并有未知模型 fallback metadata 警告，生产兼容尚未验证。4 场景 3 通过，审计保持失败项，所有审计进程已收尾。

## 历史审计结论（续作前，当前状态以上表为准）

用户要求：启动/加载提速、Codex 非 GPT 模型、腾讯 WorkBuddy、Claude Desktop、OpenCode 接入；自主实施并逐项记录，不在上下文压缩后重新开始。

**此前将 P1–P5 全部标记为完成的记录不成立。2026-09-17 已逐项核查并撤销该结论。下面的状态替代旧记录。** 编译、类型检查和模板单测通过不能替代真实客户端验收。

## 续作前的改动与验收状态

| 项目 | 实际做过的修改 | 复核结论 | 当前状态 |
| --- | --- | --- | --- |
| 启动/加载提速 | `electron/main.ts` 重叠迁移的异步收尾与 Windows 探测，按需构造 Realm 并补挂画布订阅 | 窗口仍等待 Windows 探测/资源检查；v2 首屏仍等待账号恢复。没有启动前后计时。恢复 API 站点时仍可能构造两个 Realm | 有局部改动，未验收 |
| Codex 非 GPT | 曾按模型家族写入 `wire_api = "chat"`，另加模型选择测试 | 本机 Codex 0.153.4 拒绝 `chat`；已撤销，恢复 `responses`。保留模型 ID 不等于模型可用 | 回归已修正，推理未接通验证 |
| 腾讯 WorkBuddy | 曾写入 `~/.config/workbuddy/config.json` 的 profile | 参考了 workbuddy.com 的同名现场服务管理产品。随后曾误将全局 `~/.codebuddy/models.json` 当作桌面目标；2026-09-18 已据真实桌面包纠正为 `.workbuddy/models.json`，见本文件顶部；此行保留当时未接入的历史状态 | 未完成 |
| Claude Desktop | 曾写入或合并 `mcpServers: {}` 并报告成功 | 空 MCP 没有接通推理。当前官方支持 Desktop on 3P gateway，旧的“只能 MCP”说法错误；空配置写入已删除 | 未完成 |
| OpenCode | 新增 provider JSON 模板、合并/备份写入、IPC/preload/service | 没有 v2 入口，没有真实客户端读取/对话验证，JSONC 与客户端配置优先级未覆盖 | 仅后台草稿 |
| 产品入口 | 曾在 `src/App.tsx`、`src/pages/SettingsPage.tsx` 新增三个按钮 | 默认 dev/compile 使用 `src/renderer-v2/main.tsx`，按钮加错界面。此次添加的 legacy UI 改动已撤销 | v2 入口未实现 |

## 本轮复核已完成的小项

- [x] A1 对照 `git diff` 和默认 v2 入口，确认旧界面按钮不进入正在运行的产品。
- [x] A2 官方 Codex 源码和 schema 均只允许 Responses；本机二进制用隔离目录、`http://127.0.0.1:1/v1` 与 `features list` 验证：`chat` 退出 1，`responses` 退出 0。没有读取真实 Key、调用生产模型接口或更改真实 Codex 配置。
- [x] A3 删除按模型家族选择 `chat` 的逻辑。测试覆盖 merge/reset 修正旧 `chat` 配置且保留所选非 GPT 模型名。
- [x] A4 核实腾讯 WorkBuddy 官方自定义模型文档与 Claude Desktop 第三方推理网关文档，来源及正确协议记录在 `docs/EXTERNAL-CLIENT-CONFIG.md`。
- [x] A5 删除 WorkBuddy 错产品模板与 Claude 空 MCP 模板；接入尚未实现时在任何文件操作前报错，避免伪成功。
- [x] A6 撤销添加到 legacy 的 UI；保留 OpenCode 后台草稿。修正非对象 JSON 会被静默覆盖的问题，测试文件写入使用宿主平台并清理临时目录。
- [x] A7 更正 README、Codex 说明、外部客户端说明和本进度文件，删除未成立的完成声明。
- [x] A8 修正后的定向测试：`config-files`、`cli-model-defaults`、`external-tool-config`、`ipc` 共 4 个文件、373 项通过；`npm run typecheck` 与 `git diff --check` 通过。仅证明本次代码回归检查通过，不代表外部客户端或性能验收；本轮未重跑完整构建/全量测试。

## 原实施顺序与完成标准（续作执行情况见 B1–B7）

按下面顺序继续，先读取本文件及已有代码，不重做 A1–A7 的调查。所有步骤完成后立即更新此表。

| 顺序 | 待完成事项 | 验收证据 |
| --- | --- | --- |
| R1 | 记录冷/热启动时间和 v2 可交互时间，处理 Windows 探测、加速校验、账号恢复对首屏的阻塞 | 同条件前后测量；慢网/恢复失败仍能进入界面；生命周期与账号隔离回归通过 |
| R2 | 核实非 GPT 模型的 Responses 支持；缺失时实现正确的协议适配，不再按名称猜协议 | 实际客户端接受配置；隔离协议测试覆盖流式输出、工具调用、取消及错误；真实可用性单独记录 |
| R3 | 按腾讯官方 `models.json` 结构增量合并，保留原模型和 `availableModels`，验证所选 Key/模型/接口匹配 | 原配置/备份可恢复；腾讯 WorkBuddy 读取配置并完成模型调用 |
| R4 | 按 Claude Desktop on 3P 官方配置实现 gateway；检测机器策略覆盖，不能猜写 configLibrary 内部封装 | 正确认证与模型发现；Claude Desktop 读取并验证 streaming/tool use；已有 MCP 保留 |
| R5 | 完成 OpenCode JSON/JSONC、配置优先级、默认模型选择、可回滚写入与客户端验证 | 真实 OpenCode 加载星芒 provider 并调用所选模型；旧配置与备份完整 |
| R6 | 在 `src/renderer-v2` 的实际工具/设置流程接入三类客户端，沿用既有 UI/IPC 模式 | 从默认 `npm run dev` 界面操作得到正确结果；失败显示真实原因；不向 renderer 返回 Key |
| R7 | 定向回归、类型检查、生产编译与界面验收；明确记录环境失败 | 分别记录编译、单测、UI、外部客户端与性能结果，不合并成笼统“全部完成” |

## 历史验证记录（来自上一轮，不代表本次修正后的验收）

- `npm run typecheck`、`npm run compile` 曾通过。
- 全量 Vitest 曾报告 4058 passed、162 skipped、4 failed；失败涉及 Windows 符号链接权限。该次运行不是全绿，本次未对干净基线复跑，不能据此保证“无新增失败”。
- 单独执行的 Node scripts 124 passed、维护/账号测试 20 passed、UI 62 passed。
- 没有外部客户端真实推理、v2 新入口操作、非 GPT Responses 工具调用或启动前后对照记录。

## 工作区保护与约束

- UTF-8 无 BOM；不输出密钥；自动化测试使用隔离目录与 mock，不请求生产模型服务。
- 不改现有 ProviderId 和账号隔离边界；不提交、推送或发布。
- `docs/renderer-v2-existing-testids.txt`、`docs/renderer-v2-missing-testids.md`、`docs/renderer-v2-testid-inventory.json` 是本任务开始前已有的未跟踪文件，保留。
- `.project-surgeon/changes/change-31/project-plan.md` 同步指向本记录；恢复工作以本文件中的未完成项为准。

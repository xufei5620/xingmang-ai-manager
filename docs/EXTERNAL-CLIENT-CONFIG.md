# 外部客户端安装、配置与打开

实现与验证日期：2026-09-17；WorkBuddy 安装恢复和桌面配置契约更新于 2026-09-18，Claude Desktop 本地第三方配置更新于 2026-09-19。默认开发和生产构建均使用 v2 界面。

## 入口与操作

首页将 **WorkBuddy、Claude Desktop、OpenCode** 作为工具行，与已有 CLI 和 Codex 桌面端一起分入“你的工具 / 还可以装”。工具行主按钮按实际状态显示“安装 → 配置 → 打开”，安装期间显示进度，检测失败显示“重新检测”。已安装的行保留配置入口和打开菜单。Codex 的“非 GPT 模型”入口位于工具行右侧更多菜单中。

首次使用未安装的客户端时，先点击“安装”；安装完成并重新检测后，再从同一行点击“配置”。保存配置会刷新工具状态；完成后返回工具行点击“打开”。已有其他来源配置的客户端保留可打开状态，连接星芒使用该行“配置”按钮。

外部客户端配置步骤：

1. 选择密钥来源：已有工具当前站点的星芒密钥、已登录账号中的启用密钥，或“自己填写星芒密钥”。
2. 点击“检测模型”，从该 Key 返回的列表中选择模型。改变密钥来源后需要重新检测。
3. OpenCode 还需选择“模型接口”，默认为 Responses，可显式改为 Chat Completions。WorkBuddy 使用 Chat Completions；Claude Desktop 应选择支持 Anthropic Messages 的 Claude 模型。
4. 点击“保存配置”。结果显示本地配置路径、备份数量和后续操作；Claude Desktop 保存后需完全退出并重新打开客户端。取消未保存的修改不会写入客户端配置。

已有完整 Key 由主进程读取，不随配置摘要或操作结果返回界面；手动填写的 Key 经保存请求交给主进程。保存前重新查询模型权限，并在网络请求后、提交前检查账号和站点是否变化。写入地址固定来自当前账号站点，界面不能指定其他服务地址。

Claude Desktop 的“已配好”依据当前生效的本地第三方推理配置是否完整（`configurationReady`），原生窗口手动保存的完整配置也显示“已配好”和“打开”。没有显式模型列表时显示“自动获取模型”；配置缺失、内容不完整或存在阻止生效的管理策略时仍提示配置。此状态不证明 Key 属于工具箱当前账号、仍有余额或在线推理已经通过。WorkBuddy 和 OpenCode 保留原有状态规则。

首页账户余额卡的“工具已连接”仅计入当前账号归属已确认的配置（`configured`）。确认归属仍要求实际配置有效、地址属于当前站点，以及本工具曾在当前账号下显式保存相同 Key 的关联。关联在主进程数据目录 `external-client-ownership/` 持久化，以站点和 userId 隔离，仅保存指纹，不保存明文 Key。切换账号、退出、外部替换 Key 或缺少关联记录时，不把该配置计入当前账号；检测不会替换客户端 Key。Claude 本地配置完整时仍可保持“已配好”，回到原账号且关联匹配后才恢复账号连接计数。

| 客户端 | 当前配置能力 | 已验证 | 尚未验证 |
| --- | --- | --- | --- |
| 腾讯 WorkBuddy | v2 弹窗、用户级 `.workbuddy/models.json` 增量事务写入 | 已安装桌面版 5.5.6 源码确认路径、数组/对象兼容及字段；历史 lite-wb 2.151.0 通过本地 mock 流式与 Read 工具回传 | 修正配置后的桌面模型加载、星芒生产推理、其他版本 |
| Claude Desktop | v2 弹窗、开发模式与本地 configLibrary 配置、系统策略冲突检测 | 2.2553.1.0 安装包源码与官方文档核实本地保存契约；验证结果见下文 | 星芒生产推理与工具调用、macOS 原生窗口 |
| OpenCode | v2 弹窗、JSON/JSONC 优先级合并、SDK 选择和默认模型 | 真实 CLI 1.18.31、本地 mock 的两种协议流式响应及工具回传 | 星芒生产上游、OpenCode 桌面 UI、其他版本 |

“检测到模型”和“配置已保存”分别证明权限列表可读、配置操作完成，不等于真实模型调用已经验证。

## 安装与启动

| 平台 | 一键安装 | 检测与打开 |
| --- | --- | --- |
| Windows x64 | 系统 winget 精确安装 `Tencent.WorkBuddy`、`Anthropic.Claude`、`SST.OpenCodeDesktop`，用户级、静默执行 | 读取安装记录和版本，验证可信文件与官方签名；Claude 商店版识别 AppX 身份，通过已注册 AUMID 打开 |
| Windows arm64 | Claude Desktop 与 OpenCode；WorkBuddy 当前 manifest 没有 arm64 安装项 | 与 Windows x64 相同，按实际安装状态显示能力 |
| macOS | 当前未实现，需从官网下载并将应用移入 Applications | 检测 `/Applications` 与用户 Applications 内的官方应用、bundle ID 和系统签名评估，通过 LaunchServices 打开 |

安装通过现有队列执行，重复点击不会启动多个安装任务。过程显示“排队 / 检测 / 下载 / 安装 / 验证”状态；只有安装后重新检测到客户端才显示完成。检测 OpenCode Desktop 不会把已安装的 OpenCode CLI 误当桌面版。

Windows x64 WorkBuddy 在受信任的 winget 缺失，或安装器启动前遇到明确的 WinINet 网络错误（包括 `0x80072efd`）时，自动切换到腾讯官方安装包。切换前再次检测，已经安装则跳过；无法确认安装状态时停止。取消、进程超时/终止、签名错误和安装器执行错误不会自动重跑。其他客户端的 winget 网络失败会显示中文原因和错误码。

备用包固定为 WorkBuddy 5.5.6，直接从 `download.codebuddy.cn` 下载。2026-09-18 实测同一官方下载地址存在两份不同的 5.5.6 包：532127544 字节的包匹配微软清单 SHA-256；532166536 字节的包使用另一份有效腾讯证书。两份均已完整下载并经 Windows 验证为 `Valid`、产品 WorkBuddy、版本 5.5.6，精确哈希固定在代码中，未知哈希仍拒绝安装。核验证据见 `artifacts/workbuddy-source-audit-2026-09-18/binary-comparison.json`。

每次下载仍校验完整哈希和腾讯 Authenticode 签名，执行前再次检查文件身份和哈希。下载有 15 分钟超时与 1 GB 上限，拒绝重定向，不接受界面传入的下载地址。用户级 NSIS 参数为 `/S /currentuser`；此固定版本仅用于缺失客户端的备用安装，不承担自动更新。

实际腾讯安装器会自动启动 WorkBuddy。普通用户安装使用验证后的正常用户临时目录和系统工作目录，避免客户端继承即将移除的下载目录；受保护执行模式仍在可信暂存中解压。安装结束只删除本次创建且身份未变的安装包，再移除空目录，保留客户端新建的运行文件，禁止递归清理仍在使用的目录。清理异常单独提示并保留内部诊断，不覆盖安装后的真实检测结果。该追加修正通过文件行为回归测试，未为验证清理而重装现有客户端。

2026-09-18 已实际完成 WorkBuddy 5.5.6 用户级安装：真实 winget 返回 `0x80072efd` 后，自动切换腾讯官方下载，经哈希与签名验证完成安装。独立扫描确认已安装、正在运行、支持打开且无检测错误；开发界面“你的工具”显示版本和配置入口。安装记录见 `artifacts/workbuddy-install-result-2026-09-18.json`。本轮未修改用户模型配置、未调用生产模型。

2026-09-19 本机只读识别的 Claude 商店版为 2.2553.1.0（9 月 17 日为 2.110.1.0），AUMID 为 `Claude_pzs8sxrjxfjjc!Claude`；本工具此次没有安装或更新 Claude。OpenCode 桌面端仍未安装，也没有在 macOS 上执行安装或启动验收。一键安装路径和启动动作由主进程处理，渲染层不传入任意命令或可执行路径。实际安装包来源、hash、签名证据及读取限制见 [官方安装来源记录](../artifacts/external-client-install-sources.md)。

## 腾讯 WorkBuddy

目标产品是腾讯 WorkBuddy AI 桌面客户端。已安装的 5.5.6 源码确认默认用户级配置为 `~/.workbuddy/models.json`，Windows 对应 `%USERPROFILE%\.workbuddy\models.json`。此前写入用户目录 `.codebuddy/models.json` 是桌面模型列表未加载的直接原因；桌面默认不会回退读取这个全局路径。项目级 `<workspace>/.codebuddy/models.json` 属于另一层配置，不能代替全局文件。不使用同名现场服务管理产品的 npm 模板，也不创建 `~/.config/workbuddy/config.json`。

新模型的核心结构如下，地址由当前账号站点决定：

```json
[
  {
    "id": "<所选模型 ID>",
    "name": "<所选模型 ID>",
    "vendor": "Custom",
    "apiKey": "<用户选择的 Key>",
    "url": "https://xm.solov.cc/v1/chat/completions"
  }
]
```

新文件采用 WorkBuddy 设置界面使用的顶层数组；已有 `{ "models": [...], "availableModels": [...] }` 对象格式也受桌面版支持，增量写入保留其根结构。原先 `vendor: "OpenAI"` 并非非法格式；新模型使用与自定义供应商表单一致的 `Custom`，已有模型的厂商字段仍保留。

写入器按模型 `id` 更新所选条目，保留其他模型、已有名称、厂商字段及未知字段。已有对象中的非空 `availableModels` 白名单追加所选模型，保留其余内容；缺省或空列表继续表示全部模型。存储原始模型 ID，运行时的 `custom-local:` 前缀由 WorkBuddy 自行处理。缺省能力字段与桌面自定义表单默认值一致：`supportsToolCall: true`、`supportsImages: false`、`supportsReasoning: false`、`useCustomProtocol: false`；已有显式值保留。这些是表单默认值，不代表已验证上游支持对应能力，也不会凭模型名称推断上下文长度。

保存先准备临时文件和原文件备份，再验证原文件与账号上下文未变化后替换；失败尝试回滚。非法 JSON、重复字段、错误字段类型及不安全路径会拒绝写入。保存后重新进入 WorkBuddy 的模型设置页，确认模型出现后再选择；必要时由用户结束当前工作并重启客户端，工具不会自动结束会话。源码存在文件监听和约 1 秒防抖同步，但已打开的设置列表不直接监听这次同步，不能仅凭文件回读就宣称桌面已加载。项目级配置可能覆盖同 ID 的用户配置。

官方依据：[WorkBuddy 模型配置](https://www.workbuddy.ai/docs/zh/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Model)、[models.json 配置指南](https://www.codebuddy.ai/docs/zh/cli/models)。

### 历史 lite 运行时验证与桌面纠正

2026-09-17，官方 `@tencent-ai/codebuddy-code@2.151.0` 包内的 WorkBuddy lite 运行时 `codebuddy-lite-wb.mjs`，在隔离用户目录与临时工作区实际读取当时写入器生成的 `.codebuddy/models.json`。新建模型与保留已有 `vendor: Anthropic` 的合并场景均使用 Chat Completions SSE，完成 Read 工具执行、文件内容回传和最终流式回答，退出码均为 0。该历史结果只验收这个 lite 运行时，不能证明 WorkBuddy 桌面版加载了同一路径。

配置中的合成 Key 仅用于 localhost mock，外网连接与辅助子进程均被拦截。该版本在 `supportsToolCall` 缺省时保留工具功能，保留 Anthropic vendor 也没有改变模型 URL 所决定的 Chat Completions 协议。详见 [WorkBuddy 历史运行时报告及纠正](../artifacts/workbuddy-client-audit-report.md)。当时没有启动 WorkBuddy 桌面窗口，也没有验收星芒生产模型。

2026-09-18 已从实际安装的桌面版 5.5.6 `app.asar` 核实路径、模型字段、保存和刷新行为，证据见 [桌面配置契约](../artifacts/workbuddy-model-contract-2026-09-18/report.md)。这次源码核实同样不代表真实模型调用已经通过。

## Claude Desktop

使用官方 **Claude Desktop on 3P** 的 gateway 配置，支持这一能力的客户端可为 Chat、Cowork 和 Code 提供第三方推理。本功能不向普通 MCP 文件写入空 `mcpServers`，也不把 Claude Code 的环境变量当作桌面端 gateway 配置。

保存以下官方字段：

```json
{
  "inferenceProvider": "gateway",
  "inferenceGatewayBaseUrl": "https://xm.solov.cc",
  "inferenceGatewayApiKey": "<用户选择的 Key>",
  "inferenceGatewayAuthScheme": "bearer",
  "inferenceCredentialKind": "static",
  "inferenceModels": ["<所选 Claude 模型 ID>"]
}
```

当前界面使用 `bearer`；底层模块也验证并支持官方的 `x-api-key` 选项。显式选择 `static` 凭据，避免保留的 helper/SSO 配置接管本次 Key。模型列表使用所选完整 ID；不根据名称推断模型能力。

### 开发模式与本地第三方推理

按用户要求，已移除 Windows 注册表写入和非 Windows 仅导出 JSON 的旧流程。现在保存到官方 **Help → Troubleshooting → Enable Developer Mode → Developer → Configure Third-Party Inference** 使用的本地配置，并开启对应用户目录的开发菜单。无需先登录 Anthropic 账号。

| 安装方式 | 本地第三方推理目录 |
| --- | --- |
| Windows 普通版 | `%LOCALAPPDATA%\Claude-3p\` |
| Windows 商店版（系统支持并启用目录排除） | `%LOCALAPPDATA%\Claude-3p\` |
| Windows 商店版（仍启用文件虚拟化，包括本机 Windows 10 19045） | `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Local\Claude-3p\` |
| macOS | `~/Library/Application Support/Claude-3p/` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/Claude-3p/` |

商店版路径由经过安装检测验证的实际可执行文件、`AppxManifest.xml` 文件虚拟化声明及运行系统版本共同决定，不能仅因存在旧目录就选用。2.2553.1.0 的清单虽将 `$(KnownFolder:LocalAppData)\Claude-3p` 列入 `ExcludedDirectory`，但新版命名空间最低要求 build 20348；本机 19045 会忽略这项声明，原生保存实测仍进入 `LocalCache`。build 18362 起的旧 `desktop6:FileSystemWriteVirtualization` 全局开关仍独立生效。第一方开发设置的 Roaming 目录单独判定，不随第三方目录一起迁移。`CLAUDE_USER_DATA_DIR` 为显式覆盖目录。Windows 旧 Roaming 数据尚未由 Claude 迁移时，提示先打开 Claude 完成迁移，避免提前创建 Local 目录让原生迁移被跳过。

保存涉及 `configLibrary/<UUID>.json`（上面的 gateway 字段）、`configLibrary/_meta.json`（`entries` 与当前 `appliedId`）、第三方目录的 `claude_desktop_config.json`（`deploymentMode: "3p"`），以及原生和第三方目录的 `developer_settings.json`（`allowDevTools: true`）。为星芒配置维护独立条目，保留用户原有配置列表、MCP、偏好及其他文件内容；重复保存复用本工具关联的配置。所有文件先验证、备份，提交失败尝试回滚，界面只返回路径和结果，不返回凭据。

配置保存后需完全退出并重新打开 Claude Desktop；工具箱不强制结束用户正在进行的会话。保存成功只表示本地配置已落盘，不代表正在运行的旧进程已重新加载，也不代表真实推理已通过。此配置可继续在 Claude 原生第三方推理窗口编辑。

系统管理策略仍有更高优先级。保留只读冲突检测；发现会覆盖本地推理的策略时阻止保存并提示处理，不能把被策略覆盖的文件写入报告为已接通。不会擅自删除管理员策略或旧配置备份。

### 验证边界

2026-09-19 核实本机 Claude **2.2553.1.0** 的官方安装包。源码确认 `configLibrary` 的元数据、UUID 配置、开发模式和第三方部署模式保存方式，与当前官方配置参考一致。只读检查本机商店版路径，开发模式已开启、当前配置条目为空。自动化使用隔离用户目录与合成 Key，不修改真实用户的 Claude 配置、不请求生产推理。

同日用户反馈原生窗口仍显示空白 Default，复核发现配置仍为 `{}`，新本地配置从未落盘，工具箱进程也尚未重启加载改动。随后完成原生手动保存和重启对照：真实变更位于 `LocalCache\Local\Claude-3p`，配置条目新增 `inferenceGatewayBaseUrl`、`inferenceGatewayApiKey`、`inferenceProvider: "gateway"`、`inferenceCredentialKind: "static"`；`_meta.json` 当前 UUID 不变，新建 `claude_desktop_config.json` 的 `deploymentMode` 为 `3p`。默认 bearer 和模型自动发现可以省略字段。Claude 重启日志确认进入 Gateway 模式、发现 9 个模型；未请求付费推理。前后原始快照仅保留在项目外的本机审计目录，报告不包含 Key。

此前仅凭安装清单把本机路径推断为普通 Local 的结论已被原生写入实证纠正，解析器现纳入 Windows build。微软规则依据：[文件虚拟化](https://learn.microsoft.com/en-us/uwp/schemas/appxpackage/uapmanifestschema/element-virtualization-filesystemwritevirtualization)、[目录排除](https://learn.microsoft.com/en-us/uwp/schemas/appxpackage/uapmanifestschema/element-virtualization-excludeddirectories)。手动配置即使没有工具箱的当前账号归属指纹，只要本地配置完整也显示“已配好”；账号归属仍单独校验，不会只凭站点 URL 把未知账号的 Key 归到当前账号，也不计入首页账号连接数。自动化覆盖这种状态与无显式模型的展示，原型检查仅验证离线 UI，不证明在线推理或原生客户端兼容性。

上游仍需支持 Anthropic Messages API 的 `POST /v1/messages`、流式响应和工具调用；`GET /v1/models` 可选，显式 `inferenceModels` 可提供模型列表。兼容的 gateway 配置不证明任意非 Claude 模型能用于 Claude Desktop，星芒上游的端点、鉴权、缓存字段及实际推理兼容性仍待验收。

官方依据：[3P 概述](https://claude.com/docs/third-party/claude-desktop/overview)、[gateway](https://claude.com/docs/third-party/claude-desktop/gateway)、[配置键](https://claude.com/docs/third-party/claude-desktop/configuration)、[Windows 策略优先级](https://claude.com/docs/third-party/claude-desktop/mdm)、[应用内配置](https://claude.com/docs/third-party/claude-desktop/in-app-configuration)。

## OpenCode

默认全局目录为 `~/.config/opencode`；Windows 为 `%USERPROFILE%\.config\opencode`。本机设置了有效的绝对路径 `XDG_CONFIG_HOME` 时，使用其下的 `opencode` 目录。OpenCode CLI 和桌面端使用同一配置体系，本轮真实验收对象为 CLI。

写入器按 `config.json` → `opencode.json` → `opencode.jsonc` 顺序合并有效全局配置，写入最高优先级的现有文件；全不存在时新建 `opencode.json`。JSONC 注释和未修改字段的格式保留，其他低优先级文件不改写。非法格式、重复字段和错误字段类型拒绝写入。

| 弹窗中的模型接口 | SDK | 预期请求路径 |
| --- | --- | --- |
| Responses（默认） | `@ai-sdk/openai` | `/v1/responses` |
| Chat Completions | `@ai-sdk/openai-compatible` | `/v1/chat/completions` |

接口应依据所选模型实际支持的协议选择，不能仅凭 GPT/非 GPT 名称判断。保存会更新 `provider.xingmang.options.baseURL`、`apiKey`、所选模型和顶层默认模型 `model = "xingmang/<所选模型 ID>"`。已有 provider SDK 与其他模型保留；需要切换所选模型协议时写入该模型的 `provider.npm`，避免改变兄弟模型的协议。

已有 provider/model 白名单与黑名单会以增量方式允许本次所选 provider 和模型。文件保存使用原文件备份、提交前快照检查和事务替换。项目配置与环境变量仍可覆盖全局配置，保存成功后应重新打开 OpenCode。

### 真实 CLI 验证

使用官方 `opencode-ai@1.18.31`，在隔离用户目录和工作区中，由本仓库真实写入器生成配置。CLI 的 `debug config` 与不带 `--model` 的实际运行共同验证默认模型选择；请求仅发往本地 HTTP mock，Key 为合成测试值。

四个场景全部通过：新建 Chat Completions、新建 Responses、Chat provider 下的 Responses 模型覆盖、Responses provider 下的 Chat 模型覆盖。两种协议均完成流式文本；两组覆盖场景均完成 read 工具调用与工具结果回传。同时验证 JSONC 优先级、注释保留、兄弟模型保留和原文件备份。

详细记录与重跑方式见 [OpenCode 真实客户端报告](../artifacts/opencode-client-audit-report.md)。该记录未调用星芒生产接口，也未操作 OpenCode 桌面 UI；不证明生产渠道可用性、账号模型权限或其他版本兼容性。

官方依据：[配置文档](https://opencode.ai/docs/config/)、[配置 Schema](https://opencode.ai/config.json)、[自定义 provider](https://opencode.ai/docs/providers/#custom-provider)。

## 本轮验证与源码入口

Claude 本地配置改造的 10 个相关测试文件 **688 项通过、32 项平台条件跳过**，涵盖配置库、备份和失败回滚、安装方式对应路径、系统策略冲突、账号/站点隔离、模型权限及 IPC 脱敏；随后补充空白默认条目和自托管地址识别，配置模块 **43/43** 复验通过。类型检查和生产编译通过。v2 外部客户端定向浏览器测试 **7/7** 通过，浅色和深色保存结果均已检查；原型安装、配置和打开流程检查通过。更早的 v2 全 App 浏览器回归为 **78/78**，不作为本次全量复验结果。

| 源码 | 职责 |
| --- | --- |
| `src/renderer-v2/features/tools/Home.tsx`、`external-model.ts` | 首页统一工具行，按状态提供安装、配置、打开入口 |
| `electron/external-client-runtime.ts` | 官方桌面客户端检测、安装队列、进度与启动 |
| `src/renderer-v2/features/tools/ExternalClientDialog.tsx` | 密钥来源、模型检测、协议选择和保存结果 |
| `src/renderer-v2/features/tools/ConfigDialog.tsx`、`model-filter.ts` | Codex 模型筛选与保存约束 |
| `electron/ipc.ts`、`external-client-contract.ts`、`system-service.ts` | 参数校验、主进程凭据解析、模型授权、账号和站点绑定 |
| `electron/external-tool-config.ts` | WorkBuddy/OpenCode 增量配置与文件事务 |
| `electron/claude-desktop-config.ts`、`claude-desktop-paths.ts`、`claude-desktop-manifest.ts`、`claude-desktop-policy.ts` | Claude 本地第三方配置事务、安装清单与虚拟化对应路径、只读策略冲突检查 |
| `electron/external-client-service.test.ts` | 服务接线与写入边界集成测试 |

本轮另将三个次级页面按需加载，同条件生产首屏 JavaScript 减少 19.7%，并验证导航保活与账号隔离，详见 [首屏加载报告](../artifacts/startup-audit-report.md)。该结果不代表 Electron 整体冷/热启动速度，客户端配置测试也不作为启动提速证据。

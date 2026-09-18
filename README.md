# 星芒AI管理工具

面向 Windows 与 macOS 的 Electron 桌面管理工具，用于检测 Node.js、npm、Python 与 AI CLI 环境，配置星芒 AI，并集中管理 Codex 会话、MCP、Skills、Plugins、备份、诊断、安装维护和主程序更新；内置星芒账号体系（注册/登录/个人中心/充值外链）与无限画布窗口。

正式发布需要 Authenticode 代码签名；普通 `npm run build` 可生成仅供本机调试的未签名安装包，但不能通过正式发布门禁。所有 Windows 包都会写入预期更新发布者，下载后的更新安装程序还会通过固定系统 PowerShell 严格核对 `Valid` 状态、文件路径和证书发布者；校验工具缺失、执行失败或结果异常均拒绝更新。详见 [发布手册](docs/RELEASING.md)。

## 开发运行

```powershell
npm install
npm run dev
```

`npm run dev` 和 `npm run compile` 默认使用 v2 界面；旧界面仅通过 `npm run dev:legacy` 或 `npm run compile:legacy` 显式选择。v2 首次绘制使用亮色，随后载入用户外观设置。开发版继承启动终端的权限；Windows 正式包按当前登录用户权限运行，不再在日常启动时弹出 UAC。

首页将 **WorkBuddy、Claude Desktop、OpenCode** 与现有工具一起放在“你的工具 / 还可以装”列表中。未安装时显示“安装”，已安装未配置时显示“配置”，配置完成后显示“打开”；工具行同步显示版本、运行状态和安装进度。Codex 行的右侧更多菜单提供“非 GPT 模型”入口。配置弹窗支持选择已有工具密钥、账号密钥或手动填写密钥，检测模型后保存。

旧 CLI 配置缺少来源记录时，扫描会只读比对当前账号的本机加密密钥缓存；Key、工具和服务地址一致即可正确识别账号配置。账号匹配不会授予自动改写权限，手动配置继续保留。新增账号来源记录绑定站点和用户，切账号或退出后重新判定；本机缓存缺失、不可读或不匹配时仍显示“已有第三方配置”，不据此重写 Key。

登录后，在顶部“搜索、打开、跳转”输入 `XM-NEBULA-10M-7Q9K`，按 Enter 或点击“领取 10 分钟加速时长”，可增加 600 秒加速时间。忽略英文大小写与首尾空白；每个账号在本机领取一次，按账号来源隔离，重启后保留。已有用量不清零，正在加速时会延长到期时间；这是本机加速权益，不同步到其他设备。

Windows 主程序使用 `requestedExecutionLevel: asInvoker`。四个 CLI 的控制台和 Codex 桌面端都按当前桌面用户启动；普通模式下 npm CLI 安装到用户 npm 全局目录，Grok 安装到 `%USERPROFILE%\.grok\bin`。若用户手工选择“以管理员身份运行”，程序会自动收紧外部命令边界。NSIS 安装器、主程序更新或 Node.js 系统安装仍可在实际需要时由 Windows 单独请求授权。Codex Desktop MSIX 如因打包服务返回 `0x80073D28`，仅本次安装请求 UAC；取消即停止，日常启动不提权。正式发布仍必须使用 Authenticode 签名。

完整验证命令：

```powershell
npm run typecheck
npm test
npm run compile
node e2e/electron-ci-smoke.mjs
node e2e/onboarding-smoke.mjs
npm run audit:production
```

按当前约定，调试阶段不运行 `npm run build`，避免提前生成 NSIS 安装包。

需要真机测试安装包时不必本机打包：GitHub Actions 的 `test-build` 工作流（仓库 Actions 页手动触发）会在云端生成未签名的 Windows NSIS 测试安装包，以 artifact 形式保留 7 天，安装时需在 SmartScreen 中选择“仍要运行”。该工作流始终 `--publish never`，与正式发布链路完全隔离，永不接触线上更新目录；云端产物不含无限画布（构建环境没有兄弟仓产物），画布验证请使用本机 `npm run dev`。

## macOS 开发与打包

macOS 需要 13.0 或更高版本。开发态可运行 `npm run dev`；Finder 启动的应用不会读取交互式 shell 的 `PATH`，请将 Node.js 和 AI CLI 安装到系统或常见用户可执行目录后再启动。完整的开发、终端 PATH 和打包说明见 [macOS 开发手册](docs/MACOS_DEVELOPMENT.md)。

Codex Desktop 的安装检测独立于配置文件，兼容 Apple Silicon 上的 Rosetta 场景；后台加速进程不会持续占用额外 Dock 图标。客户机检测方法见 [macOS 客户端诊断](docs/MACOS-CLIENT-DIAGNOSTICS.md)。

本机可构建仅带 ad-hoc 完整性签名的 Apple Silicon 解包应用：

```bash
npm run build:mac:dir
```

`npm run build:mac` 会生成 arm64 与 x64 的 DMG/ZIP 候选产物，并且始终 `--publish never`。这些仅带 ad-hoc 签名的候选只供开发验证，不能分发；正式 macOS 发布需要 Developer ID、hardened runtime 与 Apple notarization，且上传更新文件不在本仓库命令的范围内。

另有免费自签发布路线：它使用长期复用的证书生成可自动更新的 arm64/x64 包，但用户首次打开仍需在 macOS 中手动确认。用户首次打开、从 ad-hoc 旧包迁移和发布者构建步骤见 [macOS 免费自签版分发手册](docs/MACOS_FREE_DISTRIBUTION.md)。

## 数据边界

- Codex 会话列表以 `%USERPROFILE%\.codex\state_5.sqlite` 的 `threads` 表为权威来源，不能用 `session_index.jsonl` 替代。
- JSONL 只按需用于会话正文、消息统计和 Markdown 导出。
- SQLite 归档或恢复前使用 online backup；写操作包含事务、持久化操作日志与失败回滚。
- 未识别的 SQLite schema 自动降级为只读，永久删除默认关闭。
- MCP 的环境变量值与 HTTP Header 值只留在主进程，renderer 仅接收变量名和 Header 名。
- Skill 卸载移动到应用回收站；配置恢复前会先备份当前文件并校验 SHA-256。

## 主程序更新

打包版本使用 `electron-updater` 的 generic provider。默认更新目录：

更新源按客户端版本分桶：

- `0.1.2` 及更早版本：`https://updates.shenfengwl.fun/xingmang-manager/`
- `0.1.3` 及更新版本：`https://updatesnew.shenfengwl.fun/xingmang-manager/`（R2 桶 `xingmang-updates-new`）

正式发布必须通过单独的 fail-fast 流程，普通 `npm run build` 只能作为本地调试打包，不能对外发布：

```powershell
npm run release:build
```

`release:build` 使用 `electron-builder --publish never`，只在本机生成并校验候选产物，不会上传文件或修改线上 `latest.yml`。构建完成不等于获得发布授权；上传安装程序、上传 `.blockmap`、替换 `latest.yml` 或操作 Cloudflare R2，必须由产品所有者针对当前版本明确下达发布指令，不能从“打包”“继续”或一次历史授权中推断。

本项目当前按产品要求允许不签名更新测试：使用 `XINGMANG_UNSIGNED_RELEASE=1` 或 `npm run release:build:unsigned` 会保留自动更新，但不写入发布者签名校验。该模式只能在确认更新桶和网络链路可信时使用，普通 `npm run build` 仍保持本地构建隔离，不会自动更新。

正式发布默认写入 `release-<package version>`。脚本会在执行任何发布步骤前确认目标目录不存在或为空；若目录含有旧产物会直接停止且不会删除文件，可通过 `XINGMANG_OUTPUT_DIR` 指向项目目录内另一个空目录。随后检查 HTTPS 更新目录没有被官网 SPA 接管，再执行类型检查、全部测试、编译、签名打包和本地产物校验。发布流程明确关闭证书自动发现，并确认安装程序状态为 `Valid` 且发布者匹配 `XINGMANG_SIGNING_PUBLISHER`；`latest.yml` 不合法、文件摘要不匹配、`.blockmap` 缺失、签名缺失或发布者不匹配都会终止发布。没有证书时只能完成源码、类型、测试和编译验证，不能生成正式发布包。

服务器必须把对应版本的 `/xingmang-manager/` 配置为真实静态目录。`0.1.3+` 的 R2 目录位于 `updatesnew.shenfengwl.fun`，旧版本目录仍保留在 `updates.shenfengwl.fun`。若 `latest.yml` 返回官网 HTML，`release:preflight` 会按设计失败；在修复静态路由前不得发布。上传时先上传安装程序和 `.blockmap`，确认完成后最后原子替换 `latest.yml`，避免客户端读到尚未就绪的新版本。部署后执行：

```powershell
npm run update:verify-feed -- --platform=windows
```

该检查会重新下载并核对远端安装程序的大小、SHA-512 和 `.blockmap`。完整的版本、静态服务器和回滚流程见 [发布手册](docs/RELEASING.md)。

构建时可通过 `XINGMANG_UPDATE_URL` 覆盖更新目录。生产地址必须是 HTTPS，且不得内嵌凭据、查询参数或片段。只有设置 `XINGMANG_UPDATE_DEV=1` 时，才允许 loopback HTTP 测试源。

正式包默认在启动页执行一次更新预检（用户可在设置中关闭）。检查在 8 秒内发现新版本时，会自动下载并显示进度；`electron-updater` 根据 `latest.yml` 的 SHA-512 和 blockmap 信息完成下载校验后，程序自动退出、安装并重启。启动界面在下载期间保持等待。若检查超过 8 秒，主界面会先打开，但原检查仍在后台继续；稍后发现更新时仍会自动下载并在校验完成后重启安装。

正式包运行期间每 3 小时执行一次版本检查。该定时任务只更新“有新版本”状态和入口，不自动开始下载；用户点击“下载更新”后，校验完成的正式包同样会自动重启安装，“重启并安装”按钮作为已下载状态下的手动兜底。关闭“启动时检查主程序更新”只跳过启动预检，不关闭运行期间的 3 小时检查。

开发态可使用仓库内的 `dev-app-update.yml` 测试真实检查与下载链路。准备一个版本号高于当前应用的本地 `release` 目录后运行：

```powershell
npm run update:serve -- --directory release
$env:XINGMANG_UPDATE_DEV = '1'
npm run dev
```

本地服务启动前同样会校验元数据、摘要和 `.blockmap`。开发态默认完全禁用更新；仅设置 `XINGMANG_UPDATE_DEV=1` 后允许检查和下载，且始终禁止安装或重启替换自身。

## 原生配置

当前账号站点决定写入地址，客户端配置请求不能另行覆盖：

| 账号站点 | Codex / Grok / OpenCode 基础地址 | Claude Code / Gemini / Claude Desktop gateway 基础地址 |
| --- | --- | --- |
| 星芒AI（账号登录） | `https://xm.solov.cc/v1` | `https://xm.solov.cc` |
| 星芒AI（Sub2API 账号） | `https://api.solov.cc/v1` | `https://api.solov.cc` |

WorkBuddy 使用对应站点的 `/v1/chat/completions` 完整地址，默认写入 `~/.workbuddy/models.json`。新文件为数组，兼容保留已有 `models/availableModels` 对象结构；新模型使用 `vendor: "Custom"`。保存前重新检测所选 Key 的模型权限；模型不在授权列表、账号切换或站点变化时拒绝写入。

Codex CLI 与 Codex 桌面端共用 `%USERPROFILE%\.codex` 配置。已有配置保存前会创建时间戳备份，用户可选择只更新 API Key/模型或重置为星芒初始配置。

首页工具行的当前配置能力与验证范围（WorkBuddy 桌面契约于 2026-09-18 纠正，Claude 本地配置于 2026-09-19 更新）：

| 入口 | 已实现 | 验证边界 |
| --- | --- | --- |
| Codex 非 GPT 模型 | 从所选 Key 检测模型，按名称筛选并显式选择，保存至 Codex CLI/桌面端共享配置 | 真实 CLI 0.153.4 向本地 Responses mock 发送非 GPT 模型 ID，流式、错误和应用层取消通过；工具回传成立但命令受本机策略阻断，生产上游未验收 |
| WorkBuddy | 增量更新 `~/.workbuddy/models.json`，新建数组并兼容已有对象，保留已有模型与未知字段，事务备份和替换 | 已安装桌面版 5.5.6 源码确认配置契约；历史 lite-wb 本地 mock 结果不能作为桌面加载验收，修正后的桌面加载与生产推理仍需验证 |
| Claude Desktop | 开启开发模式，保存并激活原生第三方推理 `configLibrary` 配置；备份已有文件，检测系统策略冲突；重启客户端生效 | 本机 Claude 2.2553.1.0 源码和官方文档核实保存契约；隔离文件、服务接线和界面测试通过，真实加载与生产推理尚未验证 |
| OpenCode | 合并全局 JSON/JSONC 配置、选择 SDK、设置默认模型；保留注释、其他模型与配置备份 | 真实 CLI 1.18.31 在本地 mock 上通过两种协议的流式响应和工具回传；未验证星芒生产上游、桌面 UI 或其他版本 |

此前客户端接入完成 468 项定向单测、另 24 项服务集成测试，以及 v2 全 App 浏览器测试 78/78。Claude 本地配置改造的最新验证范围见 [外部客户端配置](docs/EXTERNAL-CLIENT-CONFIG.md)。真实运行时证据见 [Codex 隔离报告](artifacts/codex-non-gpt-client-audit-report.md)、[OpenCode 四场景报告](artifacts/opencode-client-audit-report.md)和 [WorkBuddy 历史 lite 两场景报告及纠正](artifacts/workbuddy-client-audit-report.md)。配置保存成功不代表生产模型调用已经接通。

此前 WorkBuddy 写入 `.codebuddy/models.json` 是桌面未加载配置的直接原因，原 `vendor: "OpenAI"` 和对象根格式本身并非无效。保存后重新进入 WorkBuddy 模型设置页确认，必要时自行重启客户端；工具不会自动结束会话。源码证据见 [WorkBuddy 5.5.6 桌面配置契约](artifacts/workbuddy-model-contract-2026-09-18/report.md)。

Windows 外部桌面客户端的一键安装使用系统 winget 的精确包 `Tencent.WorkBuddy`、`Anthropic.Claude`、`SST.OpenCodeDesktop`，完成后重新检测安装结果。WorkBuddy 当前安装源为 x64；Claude Desktop/OpenCode 支持 x64 与 arm64。缺少受信任的 winget 时显示修复提示。macOS 当前支持检测和打开已安装的官方应用，自动安装尚未实现，需先从官网下载并放入 Applications。安装源、签名和本机检测证据见 [官方安装来源记录](artifacts/external-client-install-sources.md)；本轮未实际安装这三个客户端。

使用步骤与配置细节见 [外部客户端配置](docs/EXTERNAL-CLIENT-CONFIG.md)和 [Codex 账号与模型配置](docs/CODEX-ACCOUNT-CONFIG.md)，实施记录见 [进度记录](docs/IMPLEMENTATION-PROGRESS-2026-09-17.md)。

## 启动性能状态

聊天、业务页和加速页改为首次访问时加载。同条件生产构建首屏 JavaScript 从 832,414 字节降至 668,193 字节，减少 **19.7%**；生产 fixture 验证首屏没有加载三个页面 chunk，导航保活与账号隔离正常，见 [首屏加载报告](artifacts/startup-audit-report.md)。

启动链路还将迁移的异步收尾与 Windows 权限探测重叠，并延迟构造未使用账号域的业务实例。窗口创建仍等待权限探测与资源检查，v2 工作台仍等待账号恢复；没有同条件 Electron 冷/热启动的完整前后计时，首屏代码减少不代表整体启动耗时减少相同比例。

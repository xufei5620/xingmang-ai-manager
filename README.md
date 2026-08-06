# 星芒AI管理工具

面向 Windows 的 Electron 桌面管理工具，用于检测 Node.js、npm、Python 与 AI CLI 环境，配置星芒 AI，并集中管理 Codex 会话、MCP、Skills、Plugins、备份、诊断、安装维护和主程序更新。

正式发布需要 Authenticode 代码签名；普通 `npm run build` 可生成仅供本机调试的未签名安装包，但不能通过正式发布门禁。所有 Windows 包都会写入预期更新发布者，下载后的更新安装程序还会通过固定系统 PowerShell 严格核对 `Valid` 状态、文件路径和证书发布者；校验工具缺失、执行失败或结果异常均拒绝更新。详见 [发布手册](docs/RELEASING.md)。

## 开发运行

```powershell
npm install
npm run dev
```

开发窗口默认使用 `1340 x 845`，主题首次为暗色，后续读取用户设置。开发版继承启动终端的权限；Windows 正式包按当前登录用户权限运行，不再在日常启动时弹出 UAC。

Windows 主程序使用 `requestedExecutionLevel: asInvoker`。四个 CLI 的控制台和 Codex 桌面端都按当前桌面用户启动；普通模式下 npm CLI 安装到用户 npm 全局目录，Grok 安装到 `%USERPROFILE%\.grok\bin`。若用户手工选择“以管理员身份运行”，程序会自动收紧外部命令边界。NSIS 安装器、主程序更新或 Node.js 系统安装仍可在实际需要时由 Windows 单独请求授权。正式发布仍必须使用 Authenticode 签名。

完整验证命令：

```powershell
npm run typecheck
npm test
npm run compile
node e2e/electron-smoke.mjs
node e2e/onboarding-smoke.mjs
npm run audit:production
```

按当前约定，调试阶段不运行 `npm run build`，避免提前生成 NSIS 安装包。

## 数据边界

- Codex 会话列表以 `%USERPROFILE%\.codex\state_5.sqlite` 的 `threads` 表为权威来源，不能用 `session_index.jsonl` 替代。
- JSONL 只按需用于会话正文、消息统计和 Markdown 导出。
- SQLite 归档或恢复前使用 online backup；写操作包含事务、持久化操作日志与失败回滚。
- 未识别的 SQLite schema 自动降级为只读，永久删除默认关闭。
- MCP 的环境变量值与 HTTP Header 值只留在主进程，renderer 仅接收变量名和 Header 名。
- Skill 卸载移动到应用回收站；配置恢复前会先备份当前文件并校验 SHA-256。

## 主程序更新

打包版本使用 `electron-updater` 的 generic provider。默认更新目录：

```text
https://updates.shenfengwl.fun/xingmang-manager/
```

正式发布必须通过单独的 fail-fast 流程，普通 `npm run build` 只能作为本地调试打包，不能对外发布：

```powershell
npm run release:build
```

`release:build` 使用 `electron-builder --publish never`，只在本机生成并校验候选产物，不会上传文件或修改线上 `latest.yml`。构建完成不等于获得发布授权；上传安装程序、上传 `.blockmap`、替换 `latest.yml` 或操作 Cloudflare R2，必须由产品所有者针对当前版本明确下达发布指令，不能从“打包”“继续”或一次历史授权中推断。

正式发布默认写入 `release-<package version>`。脚本会在执行任何发布步骤前确认目标目录不存在或为空；若目录含有旧产物会直接停止且不会删除文件，可通过 `XINGMANG_OUTPUT_DIR` 指向项目目录内另一个空目录。随后检查 HTTPS 更新目录没有被官网 SPA 接管，再执行类型检查、全部测试、编译、签名打包和本地产物校验。发布流程明确关闭证书自动发现，并确认安装程序状态为 `Valid` 且发布者匹配 `XINGMANG_SIGNING_PUBLISHER`；`latest.yml` 不合法、文件摘要不匹配、`.blockmap` 缺失、签名缺失或发布者不匹配都会终止发布。没有证书时只能完成源码、类型、测试和编译验证，不能生成正式发布包。

服务器必须把 `/xingmang-manager/` 配置为真实静态目录。若 `latest.yml` 返回官网 HTML，`release:preflight` 会按设计失败；在修复静态路由前不得发布。上传时先上传安装程序和 `.blockmap`，确认完成后最后原子替换 `latest.yml`，避免客户端读到尚未就绪的新版本。部署后执行：

```powershell
npm run update:verify-feed
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

星芒 AI 固定地址：

- Claude Code、Codex CLI、Codex 桌面端、Gemini CLI：`https://api.solov.cc`
- Grok CLI：`https://api.solov.cc/v1`

Codex CLI 与 Codex 桌面端共用 `%USERPROFILE%\.codex` 配置。已有配置保存前会创建时间戳备份，用户可选择只更新 API Key/模型或重置为星芒初始配置。

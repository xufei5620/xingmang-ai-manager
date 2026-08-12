# 星芒AI管理工具发布手册

本手册只描述 Windows 正式发布。调试阶段不需要生成安装包；准备发布时必须使用 `npm run release:build`，不能把未经发布门禁校验的普通 `npm run build` 产物对外分发。`release:build` 只生成和验证本地候选产物；上传文件、修改 Cloudflare R2 或切换线上 `latest.yml` 必须获得产品所有者针对当前版本的明确发布授权，不能把构建请求、继续开发或历史授权解释为本次发布许可。

## 1. 发布前置条件

依赖安全审计固定使用官方 npm registry：

```powershell
npm run audit:production
npm run audit:official
```

国内镜像不提供 npm audit API，返回 404 不能视为“无漏洞”。
CI 对生产依赖中的任意漏洞和完整依赖树中的 critical 漏洞执行阻断；`audit:official` 仍须在正式发布前人工复核全部开发依赖公告。当前 Electron 打包链的上游 high 公告若只能通过降级解决，应记录评估结果，不能用未经打包回归的强制降级换取表面上的零告警。

- 在 `package.json` 提升版本号，版本必须高于已发布版本。
- 更新根目录 `release-notes.md`，内容会在打包时写入更新清单并显示在客户端更新页面。
- 使用专用 Windows 发布机，系统时间正确，依赖锁文件未被临时改写。
- `https://updates.shenfengwl.fun/xingmang-manager/latest.yml` 必须返回静态 YAML 或 404。返回 `text/html`/官网 SPA 属于发布阻断故障。
- Windows 主程序必须以 `asInvoker` 运行，不能在日常启动或打开 AI 工具时主动请求管理员权限。普通模式下 npm CLI 与 Grok 使用当前用户目录；NSIS 安装、主程序更新或 Node.js 系统安装只在实际执行该操作时交给 Windows 请求所需授权。打包门禁会拒绝重新引入 `RunAs` 的 CLI 启动链。
- 正式发布必须使用 Authenticode 签名；没有证书、固定发布者或干净 Windows 验收机时，发布预检会直接失败。
- 所有 Windows 包的 `app-update.yml` 都写入预期发布者，防止 `electron-updater` 因缺少 `publisherName` 跳过验证。客户端使用受保护系统目录中的 PowerShell 严格核对下载文件的 `Valid` 状态、返回路径和发布者 DN/CN；PowerShell 缺失、命令失败、输出无法解析或任一字段不匹配均拒绝更新。
- 普通 `npm run build` 在未设置 `XINGMANG_RELEASE=1` 时可生成仅供本机调试的未签名安装包。正式发布脚本会设置发布模式并拒绝 `XINGMANG_ALLOW_UNSIGNED_RELEASE=1`，发布模式下构建配置始终强制签名。
- 正式发布前配置证书路径和固定发布者，例如：

```powershell
$env:WIN_CSC_LINK = 'C:\secrets\xingmang-signing.p12'
$env:CSC_KEY_PASSWORD = '<证书密码>'
$env:XINGMANG_SIGNING_PUBLISHER = '绍兴星芒文化传媒有限责任公司'
```

更新地址可按需通过环境变量覆盖：

```powershell
# 可选；不设置时使用正式默认地址
$env:XINGMANG_UPDATE_URL = 'https://updates.shenfengwl.fun/xingmang-manager/'
```

## 2. 构建与本地门禁

```powershell
npm run release:build
```

默认输出目录为 `release-<package version>`。脚本在联网预检、测试或构建前要求目标目录不存在或为空；检测到旧安装包、旧 `latest.yml` 或任何其他文件时会立即失败，并且绝不自动删除现有产物。需要保留同版本的多次候选构建时，显式指定项目目录内新的空目录：

```powershell
$env:XINGMANG_OUTPUT_DIR = 'release-0.1.4-candidate-2'
npm run release:build
```

执行顺序固定为：

1. 检查 HTTPS 更新 URL 和远端静态路由。
2. 执行 TypeScript 类型检查、全部单元测试和前端/主进程编译。
3. 运行主界面与首次启动向导的开发态 Electron 冒烟测试。
4. 以 `XINGMANG_RELEASE=1` 和关闭证书自动发现的环境运行 `electron-builder --publish never`，使用显式证书生成已签名 NSIS 安装程序。
5. 校验打包程序的 Electron fuse、`app.asar` 和渲染页/IPC 启动状态，并确认远程调试参数被拒绝。
6. 复制并篡改 `app.asar`，确认打包程序因嵌入式 ASAR 完整性校验而拒绝启动。
7. 校验当前空发布目录中生成的 `latest.yml` 结构、每个本地文件的大小与 SHA-512，以及主安装程序 `.blockmap`。
8. 使用 Windows `Get-AuthenticodeSignature` 确认安装程序状态为 `Valid`，并严格匹配 `XINGMANG_SIGNING_PUBLISHER`。

任一步失败都不得继续上传。

全部门禁通过也只表示候选产物具备发布条件，不会自动上传，且不构成发布授权。

## 2.1 CI 发布（GitHub Actions，2026-08-12 起）

老板决定把出包这一步搬到 CI。`.github/workflows/release-build.yml` 在 `windows-latest` 上跑的就是上面第 2 节那条完全相同的链路（它直接调用 `npm run release:build`），只是证书来自仓库 Secrets 而不是发布机磁盘。

**一次性配置**：在仓库 Settings → Secrets and variables → Actions 配置三个 secret。

| Secret 名 | 内容 |
|---|---|
| `WIN_CSC_LINK_BASE64` | 代码签名证书 `.p12` 的 **base64 文本**（electron-builder 直接接受 base64，证书不落盘） |
| `WIN_CSC_KEY_PASSWORD` | 该证书的密码 |
| `XINGMANG_SIGNING_PUBLISHER` | 固定发布者名，例如 `绍兴星芒文化传媒有限责任公司` |

把 `.p12` 转成 base64（在你自己的机器上做，不要在任何共享环境里做）：

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes('C:\secrets\xingmang-signing.p12')) | Set-Clipboard
```

**每次发布**：Actions → `release-build` → Run workflow，在 `confirm_version` 里填 `package.json` 里的版本号（填错会在第一步就失败，这是防误发的闸）。跑完在 run 页面下载 artifact，里面是 `Setup.exe` + `.blockmap` + `latest.yml` 三件套，日志里有每个文件的 SHA-256，上传到对象存储后可逐个比对。

**这条 workflow 永远不会上传到更新服务器**，也没有配置任何对象存储凭据。上传仍按第 4 节由人执行——本手册要求每次发布都要产品所有者针对当前版本明确授权，把上传自动化等于取消那道授权。

两点与本机发布的差异要知道：

- **画布**：云端没有兄弟仓 `xingmang-canvas` 的 v1 产物，所以 CI 会现场构建仓内的 `canvas-v2` 打进包里。也就是说 **CI 出的正式包带的是 v2 画布**，与测试包一致。若某次发布要改回 v1，只能在本机构建。
- **版本必须高于线上**：发布前置检查会拉取线上 `latest.yml` 比对，版本没提升会直接失败——这是好事，能拦住忘记改版本号的发布。

## 3. 静态更新目录

当前静态源使用 Cloudflare R2：

```text
Bucket: xingmang-updates
Custom domain: updates.shenfengwl.fun
Object prefix: xingmang-manager/
```

更新目录至少包含：

```text
latest.yml
XingMang-AI-Manager-<version>-Setup.exe
XingMang-AI-Manager-<version>-Setup.exe.blockmap
```

建议响应类型：

- `latest.yml`: `application/yaml` 或 `text/yaml`
- `.exe`: `application/vnd.microsoft.portable-executable` 或 `application/octet-stream`
- `.blockmap`: `application/octet-stream`

更新目录不能配置 SPA fallback。不存在的文件应返回 404，不能返回状态 200 的官网 HTML。

## 4. 经明确授权后的原子发布

只有在当前版本已获得明确发布授权后，才执行以下步骤：

1. 保留当前线上 `latest.yml` 和对应旧版本产物，作为回滚点。
2. 先上传新安装程序和 `.blockmap`，不要覆盖 `latest.yml`。
3. 确认两个新文件已完整落盘并可通过 HTTPS 下载。
4. 最后用原子 rename/replace 发布新的 `latest.yml`。不要边上传边覆盖线上文件。
5. 运行远端完整校验：

```powershell
npm run update:verify-feed -- --platform=windows
```

该命令会下载远端 `latest.yml` 和安装程序，重新计算 SHA-512，并确认 `.blockmap` 可访问。任何失败都应立即恢复旧 `latest.yml`。

6. 使用已安装的旧版本完成一次“启动更新预检 → 自动下载并校验 → 自动重启安装”。另验证运行期间检查发现新版本后，用户点击下载也会在校验完成后自动重启安装。确认安装后的版本和用户配置均正确。

### Codex Desktop 国内镜像

管理工具使用 OpenAI 官方清单判断最新商店版本，并通过以下固定国内镜像读取可下载版本和 MSIX：

```text
https://codexapp.agentsmirror.com/latest/manifest
https://codexapp.agentsmirror.com/latest/win-x64
https://codexapp.agentsmirror.com/latest/win-arm64
```

镜像必须原样同步 OpenAI 官方文件，不能改写清单或重新打包 MSIX。服务端应为清单返回 `application/json`，为 MSIX 返回 `application/vnd.ms-appx` 或 `application/octet-stream`，不存在的文件必须返回 404，不能回退到官网 HTML。客户端会校验产品身份 `OpenAI.Codex`、版本、架构、Publisher 和 `AppxSignature.p7x`，Windows 安装器还会执行系统签名验证。

镜像和官方清单查询失败时，客户端会分别保留具体错误用于诊断；下载地址固定在源码和测试中，避免运行环境把管理员安装流程重定向到未知主机。

## 5. 客户端更新行为

- 正式包默认在启动页检查一次更新；用户可在设置中关闭该启动预检。
- 启动检查发现新版本后自动下载，下载进度显示在启动页；下载校验完成后约 300ms 自动调用安装并重启。
- 启动检查等待上限为 8 秒。超时后先显示主界面，但检查请求不会取消；若后台稍后发现版本，仍继续自动下载、校验和重启安装。
- 正式包运行期间每 3 小时检查一次。定时检查只报告新版本，不自动下载；用户点击下载后，已校验的下载仍会自动重启安装。
- 关闭“启动时检查主程序更新”只跳过启动预检，不影响运行期间的 3 小时检查。
- 开发态默认禁用更新；设置 `XINGMANG_UPDATE_DEV=1` 后只允许检查与下载，安装始终被服务端拒绝。

## 6. 开发态更新验证

仓库内 `dev-app-update.yml` 固定指向 `http://127.0.0.1:8123/`。准备一个由 `electron-builder` 生成、版本高于当前应用的本地目录后运行：

```powershell
npm run update:serve -- --directory release --port 8123
```

另开终端：

```powershell
$env:XINGMANG_UPDATE_DEV = '1'
npm run dev
```

此模式可测试 `latest.yml` 读取、版本发现、下载进度、摘要校验和错误展示。开发态安装动作被更新服务明确禁止，不会自动重启替换调试程序，这是预期行为。端口变更时，需要同时修改 `dev-app-update.yml`。

也可单独校验本地 HTTP 更新源：

```powershell
npm run update:verify-feed -- http://127.0.0.1:8123/ --allow-local --platform=windows
```

## 7. 回滚

- 若新 `latest.yml` 尚未发布，删除未引用的新产物即可。
- 若新 `latest.yml` 已发布但验收失败，原子恢复旧 `latest.yml`。保留新产物用于调查，不要让它继续被元数据引用。
- 不得用修改后的同版本安装程序覆盖线上文件。任何二进制变化都必须提升版本并重新生成 `latest.yml`。

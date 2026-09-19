# 星芒AI管理工具发布手册

本手册只描述**当前生效**的发布流程：Windows 走无签名发布，macOS 走免费签名分发。历史签名方案（`npm run release:build`、`.github/workflows/release-build.yml` 的「CI 发布」配置、证书与固定发布者要求）已整段移到 [`docs/archive/RELEASING-signed.md`](archive/RELEASING-signed.md)，保留待 CA 证书到手，不适用于当前发布。

## 1. 当前 Windows 发布策略

产品所有者已明确（2026-09-05）：当前和后续 Windows 对外发布固定使用无签名模式，不需要代码签名证书或 `XINGMANG_SIGNING_PUBLISHER`，不得在审计或维护中重新引入这些发布前置要求。

使用现有无签名发布入口：

```powershell
npm run release:build:unsigned
```

此入口构建安装包但不上传，保留客户端自动更新；`forceCodeSigning=false`，更新配置不写入 `publisherName`。发布入口与普通 `npm run build` 都使用默认 renderer-v2 编译并生成 `dist/renderer-v2.flag`；旧界面只通过 `compile:legacy` 显式构建。普通 `npm run build` 仍是关闭自动更新的本地调试构建。

从 2026-09-18 起，`release:build:unsigned` 与签名入口共用 `scripts/run-release-build.cjs` 的同一份步骤表（审查总表 `M-01`）。无签名模式下会照常执行：

1. 发布前置检查（含「远端版本必须低于本地」）
2. `npm run typecheck`
3. 全部单测（`npm test`，三平台同一条命令）
4. `npm run compile`，并确认产出 `dist/renderer-v2.flag`
5. `e2e/electron-ci-smoke.mjs` 启动冒烟
6. `e2e/onboarding-smoke.mjs` 首启向导冒烟
7. electron-builder 构建未签名安装程序
8. Electron fuse 加固校验与加固后生产程序启动
9. ASAR 篡改必须被拒
10. `latest.yml` 结构、文件大小、逐文件 SHA-512 与 blockmap 校验

无签名模式下**只跳过**第 10 步里的 Authenticode 签名主体比对，跳过原因会打印在构建日志里。只做产物校验时用 `npm run release:verify:unsigned`。

注意：无签名入口现在与签名入口一样要求输出目录不存在或为空（默认 `release-<版本号>`，可用 `XINGMANG_OUTPUT_DIR` 指定）。重跑同一版本前先把上次的产物移走或换一个新的空目录。

### 从 0.2.3 起的私有加速资源

产品所有者确认先分发本机计时版：每账号在本机累计 20 分钟，节点随本地 Windows 安装包提供，不上传 GitHub。TUN 尚未接入。源码和 CI 构建默认不含线路。

先编译主进程，再将资源准备到项目外的新空目录；开发配置文件仅含 `version:1`、绝对 `corePath`、`coreSha256` 和绝对 `profilePath`。下列为占位路径：

```powershell
node node_modules/typescript/bin/tsc -p tsconfig.electron.json
node scripts/stage-acceleration-bundle.cjs --config 'C:\私有配置\acceleration-development.json' --output 'C:\私有发布\0.2.3\acceleration' --core-version v1.19.29 --source-ref v1.19.29 --license 'C:\许可\LICENSE-mihomo.txt'
$env:XINGMANG_ACCELERATION_BUNDLE_DIR = 'C:\私有发布\0.2.3\acceleration'
$env:XINGMANG_OUTPUT_DIR = 'release-0.2.3'
npm run release:build:unsigned
```

脚本要求完整 GPL v3 许可并附对应源码地址；内核必须与运营者固定 SHA256 一致。只投影内联节点，不导入上游 Clash 的规则、订阅、控制接口、TUN 或脚本配置。打包前再次检查五文件白名单和资源哈希，哈希写入 ASAR 内 metadata。

实际发布前核对包内 `resources/acceleration` 与受保护 metadata 一致，再测试 packaged helper 的开始、停止及父进程断连恢复。不能用没有节点的 CI 安装包替换本地验证过的加速版本。共享节点仍可被从包中提取，本机时间也不是跨设备服务器额度；此局限已由产品所有者接受。

发布前仍需提升版本号、更新 `release-notes.md` 并完成类型检查、测试、编译和安装包验证。上传文件、修改 Cloudflare R2 或切换线上 `latest.yml` 必须获得产品所有者针对当前版本的明确发布授权，不能把构建、合并 PR 或历史授权解释为本次发布许可。

## 2. macOS 0.2.4 双架构加速资源

Mac 资源使用 `--platform darwin --arch arm64` 或 `--arch x64` 准备，资源清单为 version 2。每个目录只含对应架构的内核，必须使用独立目录与单架构构建命令；目标平台或架构不符会拒绝构建。两次构建后汇总两份 ZIP 清单，最后执行完整双架构验证。

本次使用官方 Mihomo v1.19.29，内核与节点文件保存在仓库外。Mac 原生网络组件通过当前构建目标编译，随安装包提供。内核保留其已固定的原始字节与上游签名，不能在代码签名阶段修改后继续使用旧哈希。

除了 `verify-macos-free-artifacts.cjs`，发布者还须检查每个最终应用的 ASAR 资源 pins、内核/节点文件哈希、原生组件路径与架构，以及组件签名。包内 `--xingmang-acceleration-worker` 入口必须能通过 IPC 完成初始化、返回仅含显示信息的线路列表并正常退出。私有节点不得上传 GitHub；R2 发布顺序沿用先安装包和 blockmap、后 `latest-mac.yml`。

## 3. 发布前置条件

依赖安全审计固定使用官方 npm registry：

```powershell
npm run audit:production
npm run audit:official
```

国内镜像不提供 npm audit API，返回 404 不能视为“无漏洞”。
CI 对生产依赖中的任意漏洞和完整依赖树中的 critical 漏洞执行阻断；`audit:official` 仍须在正式发布前人工复核全部开发依赖公告。当前 Electron 打包链的上游 high 公告若只能通过降级解决，应记录评估结果，不能用未经打包回归的强制降级换取表面上的零告警。

- 在 `package.json` 提升版本号，版本必须高于已发布版本。
- 执行 `npm run changelog:collect`：把 `changes/unreleased/` 下的分片按 `## 用户` / `## 开发` 分别汇入 `release-notes.md` 的「未发布」段与 `CHANGELOG.md` 的 `## Unreleased` 段，并删除已汇总的分片文件。
- 汇总后把这两个标题改成本次版本号（`未发布` → `0.2.7`，`## Unreleased` → `## 0.2.7 - <日期>`），按需润色文案。`release-notes.md` 的内容会在打包时写入更新清单并显示在客户端更新页面。
- 发布前置检查（`npm run release:preflight`，`release:build` 的第一步）会断言 `release-notes.md` 的第一行等于 `package.json` 的版本号：忘了改标题时门禁直接失败，不会把「未发布」当成版本名发到客户端更新页（审查总表 P-14）。
- 使用专用 Windows 发布机，系统时间正确，依赖锁文件未被临时改写。
- 更新清单必须由对应版本的静态 R2 目录提供：`0.1.2` 及更早版本检查 `https://updates.shenfengwl.fun/xingmang-manager/latest.yml`，`0.1.3+` 检查 `https://updatesnew.shenfengwl.fun/xingmang-manager/latest.yml`。两者返回 `text/html`/官网 SPA 都属于发布阻断故障。
- Windows 主程序必须以 `asInvoker` 运行，不能在日常启动或打开 AI 工具时主动请求管理员权限。普通模式下 npm CLI 与 Grok 使用当前用户目录；NSIS 安装、主程序更新或 Node.js 系统安装只在实际执行该操作时交给 Windows 请求所需授权。打包门禁会拒绝重新引入 `RunAs` 的 CLI 启动链。
- 普通 `npm run build` 仍生成仅供本机调试的未签名安装包。按产品要求，明确设置 `XINGMANG_UNSIGNED_RELEASE=1` 或运行 `npm run release:build:unsigned` 时，未签名包会保留更新能力但不写入发布者签名校验；该模式不得与 `XINGMANG_RELEASE=1` 或 macOS 正式发布模式同时启用。
- 无签名包在 `package.json` 里带上 `xingmangUnsignedRelease: true`。主进程据此把更新改成用户确认式：启动检查只提示新版本，下载和安装都等用户在更新页点击，并在下载完成后按更新清单的 SHA-512 重新校验安装包，校验值缺失或不一致一律拒绝安装。发布无签名包时必须确认 `latest.yml` 为每个安装包写出了 `sha512`，否则客户端会拒绝该次更新。
- 记下本次出包的 commit（`git rev-parse HEAD`）。发布完成后要用它打 `v<版本号>` 的附注 tag，见第 5 节。

更新地址可按需通过环境变量覆盖：

```powershell
# 可选；不设置时使用正式默认地址
$env:XINGMANG_UPDATE_URL = 'https://updatesnew.shenfengwl.fun/xingmang-manager/'
```

## 4. 静态更新目录

当前静态源使用 Cloudflare R2，按版本分为两个更新桶：

```text
0.1.2 及更早：Bucket xingmang-updates，Custom domain updates.shenfengwl.fun
0.1.3+：Bucket xingmang-updates-new，Custom domain updatesnew.shenfengwl.fun
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

## 5. 经明确授权后的原子发布

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

7. 给本次出货的 commit 打附注 tag 并推送，见下一节。

### 发布后：给出货的 commit 打 tag

到 0.2.6 为止仓库一个 tag 都没有。本机出的包除了发布者自己的磁盘没有任何留存，CI 出的包也只在 Actions 里保留 30 天。一旦过期，客户手上的安装包与某个 commit 之间就没有任何持久对应关系：出问题无法 bisect，也无法证明出货产物来自哪份源码。所以每次发布的最后一步固定是给出货的 commit 打 tag。

打 tag 的对象是**本次实际出包的那个 commit**，不是「发布当天的 main」——提升版本号之后、构建之前可能又合进了别的改动。出包前先记下来：

```powershell
git rev-parse HEAD
```

产物上传完成、`update:verify-feed` 通过、并且用旧版本实际验收过一次自动更新之后：

```powershell
git fetch origin
git tag -a v0.2.7 <出包的 commit> -m "0.2.7"
git push origin v0.2.7
```

约定三条：tag 名固定为 `v` 加 `package.json` 里的版本号；用附注 tag（`-a`）而不是轻量 tag，让 tag 自带打标时间和打标人；tag 推上去之后不移动、不删除。本次产物有问题时提升版本号重新发布，按第 8 节回滚，不要让同一个 tag 指向另一个 commit。

#### 补打历史版本的 tag

0.2.1 ~ 0.2.6 都已经发出去且没有 tag。下面是按 `package.json` 版本变更推断出的候选 commit，**仅供确认用**——如上所述，提升版本号的 commit 未必就是当时实际出包的那个。补打之前要由产品所有者逐个核对，确认不了的版本宁可不补，也不要打一个指向错误 commit 的 tag。

| 版本 | 候选 commit | 日期 | 提升版本号的提交 |
|---|---|---|---|
| 0.1.32 | `ec26b33` | 2026-09-08 | 重建 v3.1.1 桌面界面并升级至 0.1.32 (#117) |
| 0.2.1 | `6ec4cf4` | 2026-09-10 | 发布 0.2.1 双账号接入与支付公告修复 |
| 0.2.2 | `a59a845` | 2026-09-12 | 完善账号配置与用量展示并发布 0.2.2 (#121) |
| 0.2.3 | `ac7650b` | 2026-09-14 | 0.2.3 本机加速与桌面配置修复 (#122) |
| 0.2.4 | `443e559` | 2026-09-14 | add macOS game acceleration and publish 0.2.4 (#123) |
| 0.2.5 | `ccf1eab` | 2026-09-16 | 发布 0.2.5，修复 Codex 配置和退出流程 (#124) |
| 0.2.6 | `43e09af` | 2026-09-19 | 升级 0.2.6，完善客户端接入与账号稳定性 (#128) |

补打时显式写出 commit，不要用 `HEAD`：

```powershell
git tag -a v0.2.6 43e09af -m "0.2.6"
git push origin v0.2.6
```

### Codex Desktop 国内镜像

管理工具使用 OpenAI 官方清单判断最新商店版本，并通过以下固定国内镜像读取可下载版本和 MSIX：

```text
https://codexapp.agentsmirror.com/latest/manifest
https://codexapp.agentsmirror.com/latest/win-x64
https://codexapp.agentsmirror.com/latest/win-arm64
```

首次安装恢复还会按需尝试上一版本，只有本机未检测到 `OpenAI.Codex` Appx 包时才会请求以下历史路由：

```text
https://codexapp.agentsmirror.com/previous/manifest
https://codexapp-r2.agentsmirror.com/previous/manifest
https://codexapp.agentsmirror.com/previous/win-x64
https://codexapp-r2.agentsmirror.com/previous/win-x64
https://codexapp.agentsmirror.com/previous/win-arm64
https://codexapp-r2.agentsmirror.com/previous/win-arm64
```

`previous/manifest` 必须返回与 `latest/manifest` 相同的 schema（包含版本、架构、Content-Length 和 SHA-256），不存在或不完整时客户端会跳过旧版并提示使用微软商店。已安装用户的更新流程不会请求这些历史路由，也不会降级安装。

镜像必须原样同步 OpenAI 官方文件，不能改写清单或重新打包 MSIX。服务端应为清单返回 `application/json`，为 MSIX 返回 `application/vnd.ms-appx` 或 `application/octet-stream`，不存在的文件必须返回 404，不能回退到官网 HTML。客户端会校验产品身份 `OpenAI.Codex`、版本、架构、Publisher 和 `AppxSignature.p7x`，Windows 安装器还会执行系统签名验证。

Windows 首先按当前用户调用 `Add-AppxPackage`。只有错误详情明确包含打包服务需要提权的 `0x80073D28` 时，才通过固定系统 Windows PowerShell 请求一次 UAC，并在工具行显示等待授权。通用 `0x80073CF6`、包冲突等其他错误不会触发提权。用户取消授权立即结束本次安装，不切换镜像或降级重试。

提权安装仅允许原 Windows 用户的管理员令牌；如果在 UAC 中输入另一 Windows 账号的凭据，会在安装前停止，避免给错误用户注册。跨用户管理员代装尚未实现。整个星芒主进程、CLI 和 Codex 日常启动维持原权限。安装助手在 Program Files 创建仅 SYSTEM/Administrators 可写且属于 Administrators 的临时副本，复制前校验清单长度，复制后校验 SHA-256并持有只读句柄安装，保留 Windows 系统签名验证。提权进程结束前不会提前释放安装队列；成功后仍由原调用进程回查当前用户的目标包版本。管理员安装失败可通过 Windows 应用部署事件日志排查。

镜像和官方清单查询失败时，客户端会分别保留具体错误用于诊断；下载地址固定在源码和测试中，避免运行环境把管理员安装流程重定向到未知主机。

## 6. 客户端更新行为

- 正式包默认在启动页检查一次更新；用户可在设置中关闭该启动预检。
- 启动检查发现新版本后自动下载，下载进度显示在启动页；下载校验完成后约 300ms 自动调用安装并重启。
- 启动检查等待上限为 8 秒。超时后先显示主界面，但检查请求不会取消；若后台稍后发现版本，仍继续自动下载、校验和重启安装。
- 正式包运行期间每 3 小时检查一次。定时检查只报告新版本，不自动下载；用户点击下载后，已校验的下载仍会自动重启安装。
- 关闭“启动时检查主程序更新”只跳过启动预检，不影响运行期间的 3 小时检查。
- 开发态默认禁用更新；设置 `XINGMANG_UPDATE_DEV=1` 后只允许检查与下载，安装始终被服务端拒绝。

## 7. 开发态更新验证

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

## 8. 回滚

- 若新 `latest.yml` 尚未发布，删除未引用的新产物即可。
- 若新 `latest.yml` 已发布但验收失败，原子恢复旧 `latest.yml`。保留新产物用于调查，不要让它继续被元数据引用。
- 不得用修改后的同版本安装程序覆盖线上文件。任何二进制变化都必须提升版本并重新生成 `latest.yml`。

## 8. 崩溃上报的 source map（暂未接入）

打包产物经过 `scripts/minify-electron.cjs` 压缩，Sentry 后台看到的堆栈因此是压缩后的行列号。
接上 source map 之后才能直接定位到源文件。这一步**当前没有做**，因为它需要一个 Sentry
auth token（和 DSN 不同，那是写权限凭据，不能进仓库）。要补的话：

1. 在 Sentry 的 Organization Settings - Auth Tokens 建一个只勾 `project:releases` 的 token，
   存成 GitHub Actions secret（例如 `SENTRY_AUTH_TOKEN`），本地则放在环境变量里，**不要**写进
   `electron-builder.config.cjs` 或任何提交的文件。
2. 让 `npm run compile` 产出 source map（`tsconfig.electron.json` 的 `sourceMap`，以及
   `scripts/minify-electron.cjs` 保留 map），并确认 `electron-builder.config.cjs` 的 `files`
   不会把 `.map` 打进安装包——map 只上传给 Sentry，不随客户端分发。
3. 发布构建之后、上传产物之前，用 `sentry-cli sourcemaps upload` 把 map 传到与
   `electron/crash-report.ts` 里 `release` 字段相同的版本号下
   （`xingmang-ai-manager@<version>`），否则 Sentry 关联不上。
4. 验证：在打包版触发一次崩溃，确认后台的堆栈显示的是 `electron/*.ts` 的行号。

在此之前，排查仍可用压缩后的行列号配合同版本的 `dist-electron` 产物人工比对。

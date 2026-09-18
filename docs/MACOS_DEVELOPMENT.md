# macOS 开发与打包

本项目支持 macOS 13.0 及更高版本。开发运行与本地打包需要 Node.js 22 LTS、npm 和 Xcode Command Line Tools：

```bash
xcode-select --install
npm ci
npm run dev
```

## 本机加速开发

Mac 本地加速复用现有选线和每账号累计 20 分钟逻辑，仅接入系统代理。M 系列使用 arm64 Mihomo，Intel 使用 x64（上游命名 amd64-v1）。内核须从官方固定版本取得并核对 SHA-256；运行前会再次检查复制后的哈希、Mach-O 类型和 CPU 架构。

`npm run dev` 会编译 Mac 原生代理组件，需 Xcode Command Line Tools。单独编译组件和运行隔离测试：

```bash
npm run acceleration:mac:prepare
npm run test:mac:proxy
```

开发版在 Electron userData 下读取 `acceleration-development.json`；正式安装版不读取此开发配置。该文件只存绝对路径和校验值，节点 YAML 与内核保存在仓库外。配置结构如下，路径和指纹均为占位值：

```json
{
  "version": 1,
  "corePath": "/private/acceleration/mihomo",
  "coreSha256": "替换为实际内核的64位SHA256",
  "profilePath": "/private/acceleration/profile.yaml",
  "profileSha256": "替换为实际配置的64位SHA256"
}
```

原生组件通过 SystemConfiguration 管理当前网络位置的物理网络服务。只在需要修改时使用 macOS 标准系统授权；读取及无恢复记录的启动检查不要求授权。原设置先写入恢复记录，停止时先恢复并确认生效，再停止内核。其他软件改过的代理不会被旧快照覆盖；若仍指向本加速端口则保留恢复记录并报告失败。

开发项目位于 Desktop/Documents 等受保护目录时，授权服务可能无法读取原生程序身份，表现为 -60008 且没有授权弹窗。组件启动前会复制到用户 Application Support 下的独立私有目录并复核哈希，避免该路径限制。每个实例使用独立副本，存活程序不会因重新编译而被覆盖；代理设置 Apply 后会有限等待系统发布生效状态。

父窗口异常退出由独立 worker 清理；worker 退出由原生组件的管道断开处理；硬杀或断电后由下一次启动读取恢复记录。关闭窗口到托盘与退出应用沿用现有语义。TUN、路由和系统 DNS 不在本轮接入范围。系统代理仅覆盖遵循系统代理设置的应用。

正式版 worker 使用同一 Electron 应用的独立进程，入口会先设置 macOS `prohibited` 激活策略，避免后台清理进程持续占用第二个 Dock 图标。普通主窗口仍保持正常 Dock 图标和单实例保护；这不改变 worker 的异常退出恢复职责。

自动化原生测试编译专用 fixture 后端，使用独立临时文件模拟偏好与生效状态；生产组件没有 fixture 参数。初次适配阶段仅做源码与本地测试。0.2.4 的 PR、合并和 macOS 双架构发布已另获用户授权。

## Finder 与 PATH

从终端运行的 `npm run dev` 会继承当前 shell 的 `PATH`；从 Finder、Dock 或 Spotlight 启动的 `.app` 不会读取 `.zshrc`、`.zprofile` 等交互式 shell 配置。请把 Node.js 和 AI CLI 安装到系统或常见可执行目录，或在应用的诊断页面确认工具已被发现。macOS 运行时会检查 `/opt/homebrew/bin`、`/usr/local/bin`、`/usr/bin`、`/bin`、`/usr/sbin`、`/sbin` 与常见用户可执行目录，而不会执行用户 shell 配置文件。

## Codex 桌面端启动

已安装 Codex App 时，“打开桌面端”直接通过系统 `/usr/bin/open -a <已验证的应用路径>` 唤起应用，不要求额外安装 Codex CLI、Node.js 或 npm。启动前沿用 bundle ID、OpenAI 签名与架构检查；未找到应用和检测未完成分别提示。

安装检测不依赖 `~/.codex/config.toml`、`auth.json` 或其他 `CODEX_HOME` 下的配置文件；已安装与已连接账号是独立状态。检测先检查系统和用户 Applications 的标准名称，再查询 Spotlight；未索引或改名的 Applications 内应用还会进行有界浅层查找，所有候选仍校验 `com.openai.codex` 和 OpenAI Developer ID 签名。架构信息直接从有界读取的 Mach-O 文件头取得，不调用 `lipo`，不要求客户安装 Xcode 或 Command Line Tools。Intel 版星芒在 Rosetta 下可通过硬件能力识别 ARM 版 Codex，Apple Silicon 下的 Intel 版 Codex 则需要系统 Rosetta 兼容环境。

两个 Dock 图标、已安装但无法确认等客户机问题，可运行 [macOS 客户端只读诊断](MACOS-CLIENT-DIAGNOSTICS.md)，检查运行副本、安装路径、架构和签名；不需要创建或填写配置文件。

工作目录使用官方 `codex://threads/new?path=...` 深链接传递，并用 `--env CODEX_HOME=...` 把选定配置目录交给新启动的应用。所有参数通过 argv 数组传递，中文、空格、引号和 URL 特殊字符不会作为命令解释。已有应用进程保持运行；`--env` 不会修改其启动时的环境，切换配置目录后需由用户退出并重新打开 Codex。

2026-09-12 修复了旧版本无条件执行 `codex app`，导致桌面端已安装却报“未检测到 Codex CLI”的问题。Windows 本地的 macOS 分支/启动计划回归通过，真实 LaunchServices 与 Mac 窗口行为仍需 macOS 实机验证。

## Grok CLI 安装与更新

macOS 上由应用管理的 Grok 安装和更新要求系统已经安装可用的 Node.js/npm 运行时；Node.js 的安装仍由用户在应用外部完成。应用只使用官方包 `@xai-official/grok`，不得替换为名称相近的未作用域包。

主进程先从 xAI 官方 stable manifest 获取 Darwin Grok 的固定发布版本，再从官方 npm registry 获取该**完全相同**版本的元数据；两者不一致会拒绝安装。随后比较完整依赖图及每项 SHA-512 integrity 值，以禁用脚本的方式填充缓存，再在已经验证的 resolution 工作区离线执行本地 `npm ci` 生命周期脚本。此命令不使用全局 npm bin 链接，因此不会覆盖旧版 shell 安装器保留的 `~/.local/bin/grok` 别名。

xAI 官方包在 macOS 采用标准的每用户 `~/.grok/bin` 原生二进制布局，通过版本化文件和原子替换符号链接完成切换。应用只信任 `~/.grok/bin/grok` 的相对链接：最终可执行文件必须仍位于 `~/.grok`，链接目标必须是官方版本化 macOS 文件，不能使用过期的 `~/.grok/version.json`。安装成功前会对该确切二进制运行 `codesign --verify --strict`，要求 xAI Developer ID authority 和 Team ID `5Y6N3AJ54S`，并要求链接版本和 `grok --version` 都等于固定发布版本。生命周期命令或任一验证失败时，应用会原子恢复旧的 canonical link；首次安装仅移除新建的 canonical link，绝不删除版本化二进制或其他文件。

Windows 仍使用现有的直接下载、经 Authenticode 验证的原生安装程序；此 macOS npm 管理流程不会改变 Windows 的安装路径。

## 本地开发打包

```bash
npm run build:mac:dir
```

该命令先编译，再为当前 Apple Silicon 开发机生成 arm64 解包 `.app`。它设置 `CSC_IDENTITY_AUTO_DISCOVERY=false`，并且在未设置发布模式时明确禁用 Developer ID 身份发现和 notarization。生成的应用只使用 ad-hoc 本机完整性签名，便于 fuses 修改后的 `.app` 在本机启动；它不是受信任的发行签名，可能被 Gatekeeper 阻止，也不能交付给其他用户。本地包携带受 ASAR 完整性保护的 `xingmangLocalBuild: true` 标记并停用自动更新，避免解包构建因没有 `app-update.yml` 而误报。

```bash
npm run build:mac
```

该命令依次运行类型检查、测试和编译，然后生成 arm64 与 x64 的 DMG 和 ZIP 候选。每个产物使用 `XingMang-AI-Manager-${version}-${arch}.${ext}` 命名；ZIP 是 Electron updater 所需的 macOS 更新载荷。两个命令均使用 `--publish never`，不会上传文件、修改更新源或发布版本。

## 免费自签发布

免费自签发布与本地 ad-hoc 包不同：它必须复用同一张长期自签证书，并写入 `xingmangLocalBuild: false`，因此主程序更新保持启用。发布时设置 `CSC_NAME` 和 `XINGMANG_MAC_SIGNING_SHA256`，再执行 `npm run dist:mac:free`；runner 会只为 electron-builder 子进程自动启用免费发布模式。该模式不 notarize，首次安装仍由用户在 Finder 或“系统设置 > 隐私与安全性”中手动确认；后续版本由 Squirrel.Mac 在固定证书和 bundle ID 连续时自动更新。完整的用户迁移、证书保管和构建步骤见 [macOS 免费自签版分发手册](MACOS_FREE_DISTRIBUTION.md)。

## 正式发布边界

Developer ID 发布是独立的正式路线：需要显式设置 `XINGMANG_RELEASE=1`，提供有效的 Developer ID Application 签名凭据，并配置 Apple `notarytool` 所需的凭据。构建配置保留 hardened runtime，并只在该发布模式启用 notarization。它不能与免费自签模式混用，构建候选也不等于获得发布授权。

签名和 notarization 完成后，Electron Builder 会为 macOS 生成 `latest-mac.yml` 与对应 ZIP 更新载荷。更新服务器必须以静态文件形式提供这两个文件及其关联资源；发布、上传、替换任何更新元数据均不属于本项目的本地构建命令或本次适配范围。

# macOS 开发与打包

本项目支持 macOS 13.0 及更高版本。开发运行与本地打包需要 Node.js 22 LTS、npm 和 Xcode Command Line Tools：

```bash
xcode-select --install
npm ci
npm run dev
```

## Finder 与 PATH

从终端运行的 `npm run dev` 会继承当前 shell 的 `PATH`；从 Finder、Dock 或 Spotlight 启动的 `.app` 不会读取 `.zshrc`、`.zprofile` 等交互式 shell 配置。请把 Node.js 和 AI CLI 安装到系统或常见可执行目录，或在应用的诊断页面确认工具已被发现。macOS 运行时会检查 `/opt/homebrew/bin`、`/usr/local/bin`、`/usr/bin`、`/bin`、`/usr/sbin`、`/sbin` 与常见用户可执行目录，而不会执行用户 shell 配置文件。

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

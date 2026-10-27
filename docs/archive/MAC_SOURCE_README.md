# macOS 源码使用说明

此压缩包是星芒AI管理工具箱 `0.1.12` 的纯源码包，不包含 Windows 安装包、
`node_modules`、编译产物、本机缓存、运行日志或审计文件。

## 准备环境

建议使用 macOS 13 或更高版本，并先安装：

- Xcode Command Line Tools
- Node.js 22 LTS（同时提供 npm）

```bash
xcode-select --install
node --version
npm --version
```

## 安装与验证

在解压后的项目目录执行：

```bash
npm ci
npm run typecheck
npm test
npm run dev
```

`npm ci` 必须在 macOS 上重新执行，不要从 Windows 复制 `node_modules`。

## macOS 构建方式

源码支持 macOS 13+，并由同一套业务源码分别构建 Apple Silicon (`arm64`) 和 Intel (`x64`) 版本：

- `npm run build:mac:dir`：生成当前开发机使用的 arm64 解包应用，仅带 ad-hoc 完整性签名，只供本机验证。
- `npm run build:mac`：生成 arm64/x64 的 DMG 与 ZIP 候选，仍为 ad-hoc 签名，不适合向普通用户分发。
- `npm run dist:mac:free`：使用发布者长期保管的同一张自签证书生成 arm64/x64 免费分发包。用户首次打开需要手动确认；证书和 bundle ID 保持不变时，后续版本可继续使用应用内自动更新。

上述命令都使用 `--publish never`，不会上传文件或创建 GitHub Release。免费自签版的首次打开、证书保管与构建门禁见 [macOS 免费自签版分发手册](docs/MACOS_FREE_DISTRIBUTION.md)；Developer ID 与 notarization 的正式路线见 [macOS 开发手册](docs/MACOS_DEVELOPMENT.md)。

## 当前平台边界

macOS 已支持本地数据、配置和会话管理，常见 Node.js/AI CLI 发现与终端启动，用户级 CLI 维护，Grok CLI 安装/更新，以及已安装 Codex 桌面端的检测与打开。下列能力仍由平台分别处理：

- macOS 不自动安装 Node.js；缺少运行时时会引导用户使用官方安装方式。
- Codex 桌面端的安装可用性取决于 OpenAI 提供的 macOS 架构版本；本工具只检测和打开兼容的已安装应用。
- Microsoft Store、Appx、注册表、Windows ACL、PowerShell/UAC 和 NSIS 仅用于 Windows。
- Windows 使用 Authenticode/NSIS 更新链；macOS 使用 DMG/ZIP、Squirrel.Mac 和对应签名链。

不要在 macOS 上运行 Windows 发布脚本，也不要把任何本地候选产物直接上传为正式版本。

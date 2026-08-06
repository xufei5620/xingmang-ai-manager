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

## 当前平台边界

当前源码仍以 Windows 为主要发布目标。下列功能需要在 macOS 适配层完成后才能正常使用：

- Windows PowerShell CLI 启动与按操作触发的 UAC 安装流程
- Node.js、CLI 和 Codex Desktop 的 Windows 安装及卸载
- Microsoft Store、Appx、注册表、Windows ACL 和 NSIS 更新流程
- Windows 安装包构建与自动更新

会话读取、配置解析、React 界面及大部分纯 TypeScript 逻辑可以作为 macOS 适配基础。
不要在 macOS 上直接运行 Windows 发布脚本或上传更新产物。

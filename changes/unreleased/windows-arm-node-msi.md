## 用户

- Windows ARM 电脑（骁龙笔记本等）上自动安装 Node.js，系统自带的应用安装器没装成时，改从安装包装也能装上了。以前这一步会报「没有可用的安装包」。

## 开发

- `electron/node-runtime.ts` 的 `parseNodeReleaseIndex`：nodejs.org 的 `index.json` 从不列 `win-arm64-msi`（2026-10-13 核过全部版本），可 v19.9.0 起列了 `win-arm64-zip` 的 165 个版本，`SHASUMS256.txt` 里都有唯一一条 `node-vX-arm64.msi`。ARM 电脑上 winget 失败后退到 MSI 那条路永远挑不到版本。现在 Windows arm64 认 `win-arm64-msi` 或 `win-arm64-zip`，下载后仍照查 SHA-256 与 OpenJS Foundation 签名。x64 与 macOS 不变。

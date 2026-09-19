## 开发

- 按产品策略将现有 12 条共享加速线路及 SHA-256 纳入 `bundled-acceleration`，Windows 和 macOS 资源准备配置省略 `profilePath` 时复用仓库节点，保留外部自定义配置及平台内核、许可、资源完整性校验。
- 新增 `scripts/prepare-acceleration-bundle.cjs`：按 `bundled-acceleration/cores.json` 钉住的版本从 Mihomo 上游取内核与同版本 GPL v3 正文，逐一核对资产、内核、许可三道 SHA-256 后交给
  `stage-acceleration-bundle.cjs` 生成资源目录；下载限定 GitHub 域名与 https，重定向逐跳复校（I10）。`package-for-testing` 两个平台的包因此都带上私有加速线路，
  `run-macos-free-build.cjs` 的「CI 临时签名不携带加速线路」限制随之取消。

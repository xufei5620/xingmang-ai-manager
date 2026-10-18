## 开发

- Codex 插件目录走 GitHub 下载时，跟跳转补齐和 Node 运行时、macOS 安装器同样的两道检查：
  走过的地址记下来，绕回去就停；响应带着地址时必须正是这一跳请求的那个，否则丢掉不落盘。
  地址里的片段先去掉再比（`electron/codex-plugin-catalog.ts` 的 `fetchCatalogArchive`，#1073 第 1 条 a）。

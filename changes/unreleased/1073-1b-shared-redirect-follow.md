## 开发

- 安装包下载的逐跳跟随跳转抽成共用的 `electron/redirect-allowlist-fetch.ts`（#1073 第 1 条 b），
  Node 运行时（`fetchTrustedNodeResource`）和 Mac 桌面端安装器（`fetchMacosDesktopResource`）换过去，
  原有校验一条不少。顺带收紧两处：Node 那份要求响应自报的地址正好是这一跳（以前同一文件的镜像地址也放过），
  跳转响应在报错前一律丢掉响应体。Codex 桌面端那份不动，Codex 插件目录、Git 运行时、Claude Desktop MSIX 三份以后再换。

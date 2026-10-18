## 开发

- Codex 插件目录（`fetchCatalogArchive`）、Git 运行时（`fetchTrustedGitResource`）、Claude Desktop MSIX
  （`fetchClaudeDesktopPackage`）三处下载跳转换成共用的 `electron/redirect-allowlist-fetch.ts`（#1073 第 1 条），
  只剩 Codex 桌面端那份按 AGENTS 第 7 节不收。原有校验一条不少，Git 给客户看的几句报错原样保留。
  共用函数加了三样：`messages` 沿用调用方原来的报错字，`fetchLandingWithRedirectAllowlist` 交回答话的那一跳
  （生产下载用的 fetch 不填 `response.url`，MSIX 续传要靠它找回上次的文件），`beyondLimit: 'return'` 让续传不跟跳转。
  顺带收紧两处：插件目录只跟 301/302/303/307/308（以前 300、304、305、306 带地址也跟），Git 要求响应自报的地址正好是这一跳
  （以前同在白名单主机上就放过）。

## 开发

- Grok 版本查询（`grok-update.ts`）和 AI 图片下载（`ai-asset-store.ts`）的跳转跟随也换成共用的
  `electron/redirect-allowlist-fetch.ts`（接 #1073 第 1 条），主进程手写的逐跳跟随只剩 Codex 桌面端那份
  （AGENTS 第 7 节不动）。原有校验一条不少，报错字照旧。图片那处每一跳仍按自己的主机挑 fetch：
  `imgen.x.ai` 走跟随代理的会话，其余先查 DNS、只许公网地址再钉住。顺带：两处被拒或被跟过去的跳转都丢掉正文
  （以前 Grok 一律不丢，图片超过次数那次不丢）。

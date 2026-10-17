## 开发

- 保存配置以外单改 Codex `config.toml` 的几处收成一套（#1068）：扩展页启停插件和技能、星芒画图技能
  跟着账号开关（连同存着的那份星芒配置）、Codex 桌面端语言都改走新的 `electron/codex-config-toml.ts`
  的 `mutateCodexConfigToml`。从读到写整段同步、不让出事件循环，保存配置的事务本来也是同步的，所以
  本进程里谁也插不进这一段：以前画图技能读完配置、等着读记录的那一会儿，别处刚写进去的改动（比如
  桌面端语言）会被它整份盖掉。每次改之前在旁边留 `.bak.<时间戳>`，以前技能开关和语言这两处不留。
  能只动几行就只动几行（表里改一个键、末尾接一张表），解析回去和要的一模一样才用，不然照旧整份重写；
  扩展页只在真整份重写时才提示「手写注释可能丢失」。
- 备份的名字和清旧备份挑哪几份收进 `electron/config-file-backups.ts`，`config-files.ts` 的保存事务和
  上面那套共用，以前两边各写一份、碰巧一致。`codex-extensions.ts` 自带的备份、临时文件、写队列那套
  删掉；写之前的路径检查改用 `safe-local-data.ts` 那套（比它原来的 `assertNoSymlinkComponents` 严，
  读和导入技能那几处没动）。`codex-context-limits.ts` 与 `codex-desktop-locale.ts` 的「按行改、对不上
  就整份重写」合用 `renderTomlEdit`。保存配置本身仍整份重写 `config.toml`，不在这次范围里。

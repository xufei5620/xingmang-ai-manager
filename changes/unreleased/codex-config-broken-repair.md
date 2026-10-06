## 用户

- Codex 的配置文件坏了、Codex 自己都读不了时，首页 Codex CLI 和 Codex 桌面端两行会写「配置文件坏了」，点「修好它」先备份、再按现在用的账号重新生成，历史会话保留。以前首页写的是「还没配 Key」，Codex 桌面端一打开就停在「无法加载组织设置」。
- 配置里点「重置为初始状态」，选当前账号或官方账号时也会先在「备份」页留一份，找得回来。以前只有自己填 Key 的那种会留。

## 开发

- 新增 `codex-config-syntax.ts` 的 `isCodexConfigBroken`：只在确定 Codex 也会拒绝时才算坏，即不是 UTF-8、有 TOML 不许的控制字符或孤立回车，
  或者 `@iarna/toml` 报的是键或表重复、写到一半、不认识的字符、`\u` 写错、`\e` `\x` 以外的未知转义。`@iarna/toml` 是 TOML 0.5，Codex 读 TOML 1.1：
  类型混合的数组、跨行或带注释的内联表、`\e` `\x`、不带秒的时间这些 Codex 认、`@iarna/toml` 不认，一律不报。拿桌面端 26.930 自带的
  Codex 0.159.0-alpha.12.1 逐条比对过。
- `config-files.ts`：`inspectProviderConfig` 给 Codex 加 `codexConfigBroken`，读原始字节（`bounded-file.ts` 拆出 `readBoundedFileSync`，
  解码会把坏字节悄悄换成 U+FFFD）。`createCodexOfficialConfigPlans` 在 reset 时容忍读不懂的旧文件，先备份再整份换掉，和中转那边的 reset 一样；
  merge 照旧报错。原来登录 ChatGPT 的客户在配置里点「重置为初始状态」也会报读不懂。
- `ipc.ts`：重置前在「备份」页留一份（全面检测 Q18）原来只做在 `config:save` 上，选的账号 Key、自动准备的 Key、官方账号这三条重置的路
  只留配置旁边会被挤掉的 `.bak`。抽成 `backupBeforeReset`，四个入口都走，留不下就不重置；首页「修好它」走的正是后两条。
- 首页（`Home.tsx`）新状态 `configBroken`，排在「配置暂未读到」之后、所有按来源的判断之前，开机先画上次结果时不下结论。「修好它」
  （`App.tsx` 的 `repairBrokenToolConfig`）就是配置「高级」里的「重置为初始状态」：登录 ChatGPT 的走官方重置，其余按当前账号
  （`configureManaged(…, 'reset')`，没登录先去登录），成功后清掉「自己填写密钥」的本机标记。三处文字照 yoyo 2026-10-06 回「改」的原话，
  悬停提示与成功提示用现成的。
- 测试：`codex-config-syntax.test.ts` 钉住两边都拒绝与只有 Codex 认的写法；`config-files.test.ts` 加首页标记与 ChatGPT 登录下重置坏文件；
  `bounded-file.test.ts` 加原始字节；`ipc.test.ts` 三条：官方账号、自动准备的 Key、选的 Key 重置前都先备份，备份不成就不写；
  `Home.test.tsx` 与 `model.test.ts` 加两行状态、按钮、优先级、忙态与缓存期不下结论；`app-check.mjs` 两条浏览器回归（夹具 `?codexBroken`）：
  从桌面端那一行点「修好它」走当前账号的重置，ChatGPT 登录的走官方重置。

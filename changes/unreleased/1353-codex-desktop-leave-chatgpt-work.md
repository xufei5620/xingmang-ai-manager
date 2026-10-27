## 用户

- Codex 桌面端左上角选成「ChatGPT Work」时，发消息会时好时坏地弹「提交消息时出错」：那个模式要登录 ChatGPT 账号才能用，
  用当前账号或自己的密钥发不出去。现在星芒写 Codex 设置时（比如登录后自动配好、在配置里点保存）会替你切回「Codex」模式。
  用 ChatGPT 账号的不受影响。

## 开发

- `electron/config-files.ts`：新增 `leaveCodexDesktopChatGptWorkMode`，在保存配置的 `applyCodexRelayConfig` 里调用（当前账号、
  自己的密钥都走这里）：`[desktop] conversationDetailMode = "STEPS_PROSE"`（桌面端的 ChatGPT Work）换成 Codex 模式的缺省
  `STEPS_COMMANDS`；没写这个键、写的是 `STEPS_EXECUTION` 都不动；`[desktop]` 里别的键原样（#1353）。切官方账号时恢复的
  官方那份原样带着客户选的模式（登录了 ChatGPT 账号 Work 能用）。
- issue 按 Windows 版 Codex 26.1013.4894 的程序核对过：Work 模式＋内置浏览器插件＋没登录 ChatGPT 三样同时成立才报
  「Work browser access requires an authenticated account」，而且要先从 statsig 读到账号的工作模式策略才查，所以时好时坏。
  本仓库拿不到桌面端安装包，这几个取值照 issue 写，没在本机再核。
- 不进开机补设置（`fillCodexRelayTemplateDefaults`，`relayTemplateRevision` 不动）：这是客户自己选的值，开机补完那句提示
  （`toolTemplateFilledNotice`）说的是「自己改过的设置都没动」。issue 里建议的「检测到就问一句要不要切回」要新的界面文字，
  这次没做。
- 测试：`config-files.test.ts` 加三条（保存时换、切官方账号换回客户选的；另一档模式和没写的不动；开机补设置不碰）。

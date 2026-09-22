## 用户

- 账号页「密钥」列表里，工具正在用的那把密钥会标上「Claude Code 在用」这样的小标签，一眼就知道哪把不能随手删。
- 撤销工具正在用的密钥时，确认框会先说清楚：这把密钥正在被哪个工具使用，撤销后会马上自动换一把新的写进去。确认后软件自己换好，不用你再设置；以前撤销完工具就悄悄用不了了，首页还显示已连接。
- 万一自动换新没成功，页面上会说明哪个工具暂时用不了，点「再换一次」就好。

## 开发

- `account:list-keys` 给结果行补可选字段 `managedProvider`：托管 Key 缓存里这把 Key 属于哪个工具，且这个工具的本机配置此刻的 Key 与缓存里的完全一致，才算「在用」。只有工具 id 跨 IPC，Key 明文不出主进程（I3）；缓存读不出、配置读不出、中途换了账号，一律退回不带标记的列表（旧行为）。
- `ipc-contract.ts` 的 `AccountKey` / `AccountKeysPage` 由别名改为在 `NewApiAccountKey` 之上扩展的接口，后端 DTO 不变。不新增 IPC 通道，`account:revoke-key` 不变。
- 渲染层：`AccountPage` / `AccountKeys` 新增可选 `onRewriteKey`，由 `BusinessPage` 转交 App 里已有的 `rewriteAccountKeys([provider])`（点名工具的 rewrite 档，与首页「重新写入 Key」同一条路）。撤销成功后对在用的 Key 自动调用；失败时记下工具，显示一条带「再换一次」按钮的提示。没传 `onRewriteKey` 时确认框不承诺自动换新。
- `e2e/v2-business.test.mjs` 三条浏览器用例：在用 Key 的提醒与自动换新、换新失败后按钮重试、无人在用的 Key 保持旧文案且不改写任何工具。

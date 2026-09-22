## 用户

- 工具的配置被别的程序或手工改动过时，首页那一行现在会直接说「配置被改过」，旁边给一颗「重新写入 Key」，点一下就按当前账号把配置写回去；确实是自己改的，就在「…」菜单里选「就用现在这份」，以后不再提示。软件不会自动覆盖任何一份被改过的配置。

## 开发

- 第四批候选 5。`electron/tool-config-ownership.ts` 的 `ToolConfigOwnership` 新增 `changed`：所有权文件确实是本程序替当前账号写下的（v2 记录、`source: 'account'`、owner 对得上），但身份指纹对不上时返回它；其余判不准的一律照旧落回 `unknown`，`saveConfig` 里「来源未经确认就不自动改写」那道闸对 `changed` 同样关着，自动同步永远不覆盖被改过的配置。
- 渲染层 `features/tools/model.ts` 的 `ToolSource` 跟着加 `changed`，只收窄原先 `unknown` 的一角：排在本机手动标记与「密钥正是当前账号缓存里那把」之后，官方登录、指到别处的配置都不受影响；`connectionReady` 对它与 `unknown` 同样处理，行为不变。
- `features/tools/account-bootstrap.ts` 新增 `rewrite` 档：只有用户点名某个工具时才把被改动过的配置列为重写目标，并对主进程带上 `intent: 'explicit'`；`login` / `restore` 两档照旧跳过（新增 `changed` 这个 skip reason）。`App.tsx` 的 `rewriteAccountKeys` 只在点名工具时走这一档，整轮「一键修复」维持原样。
- 首页新增 `configChanged` 状态（`registry/status.ts`，warn 色）、`tool-<id>-rewrite-key` 按钮与「就用现在这份」菜单项；后者写的是配置对话框「自己填写密钥」同一个本机来源标记，改回星芒账号时自动清掉，没有新增 IPC 通道。
- 新增单测：所有权 store 七条（键被改 / 我们写的 base URL 被删 / 用户加的别的键不算改动 / 换账号或未登录不归因 / 自动写入仍被拒 / 显式写入可以收回 / 手动记录被改后仍是 unknown）、`sourceFor` 五条、bootstrap 计划两条、`Home` 三条，以及 `app-check.mjs` 两条浏览器用例。

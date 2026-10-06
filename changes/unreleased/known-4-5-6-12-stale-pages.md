## 用户

- 从终端切回星芒直接点首页或「记录」里的「接着聊」：要是同一个文件夹里刚在终端里又聊了一条，这次先不打开，按钮挪到刚聊的那条上，
  再点一次就接上它；以前点下去接上的其实是刚聊的那条，跟点的不是一条。
- 「外接工具」「技能」「插件」「安装卸载」页再进去时会自己重新读一遍，在别处装好、删掉的东西不用再点「重新加载」才看得到。
- 装好、卸掉工具或者改完工具设置以后，底下状态栏不再挂着上一次检查的「环境有 N 项需要处理」，改回「环境待检测」，点它去检查页会重新查；
  检查页开着的时候也会自己再查一遍。
- 首页「已完成 N 组工具的 Key 配置。」这句摆一会儿就自己收起，不再一直挂着；有没配好的、要留意的照旧一直摆着。

## 开发

- 已知4：`features/tools/recent-workspaces.ts` 加 `resumeNeedsRecheck`、`resumeStillLatest`。首页 `Home.tsx` 的「接着聊」（按文件夹接最近
  一条的 Claude Code、Gemini CLI、Grok CLI）点下去先作废一分钟缓存、现读一份「最近」，点的这条已经不是它（工具 × 文件夹）最近的
  一条就换上新列表、这次不打开；读不到照旧打开；Codex 按记录 id 接，不读。记录页 `SessionsPage` 同一下，放在打开前那几道关之前
  （问完话再说不打开等于白问），不一致时列表一起重读。
- 已知5：`pages-business.tsx` 给三个 `ExtensionsPage` 传 `active`，`ExtensionsPage`、`MaintenancePage` 接 `useReloadWhenShown`，
  再显示时重读，在读就不再起一轮；外接工具的连接检测（`checkProviderMcpHealth`）照旧不跟着重跑。
- 已知6：`features/app/environment-status.ts` 加 `markDiagnosticsStale`（状态栏退回「环境待检测」）和环境版本号，`publishDiagnosticsCounts`
  可带开跑时的版本，跑到一半环境改过就不交（缺省＝旧行为）。`App.tsx` 在工具行任务收尾（`environmentJobsFinished`，打开工具不算）、
  配置窗口保存、账号 Key 真写了或修了 Codex 老配置、备份恢复、密钥页「配置到工具」、`onSystemChanged` 时标过期，不在后台替客户重查。
  检查页开着时版本一变就重查一次，在查就等这一轮查完。
- 已知12：`App.tsx` 给账号 Key 同步的结果记 `finishedAt`；`Home.tsx` 的 `bootstrapNoticeExpiresAt` 让只说「已完成 N 组工具的 Key 配置。」
  的那句照右下角提示条的读完时长（`toastDurationMs`）到点收起，回首页时已过点的不再出现；有失败、有提醒、被网拦住的照旧常驻。
- 测试：单测补 `recent-workspaces`、`environment-status` 和首页横幅；`app-check.mjs` 补七条（首页和记录页「接着聊」先对一次、Codex 不读、
  扩展三页和安装卸载页再显示重读、状态栏装完退回灰点、检查页自己重查、横幅到点收起）。原「记录页接着聊后回到窗口」那条，「最新 100 条」
  的读次数多一次（点的时候先对的那一下）。
- 2026-10-06 已知问题清单 A 组 4、5、6、12；yoyo 2026-10-06「把已知的问题都做完」。

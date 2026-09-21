## 用户

- 给 Claude Code 装插件时，软件会自动把官方插件市场加进来，不用再先去终端跑一次 claude。此前没在终端用过 Claude Code 的电脑，装任何官方插件都会报「市场里找不到」。
- 这台电脑上没有 Git 时，装插件会直接说明需要先装 Git 以及去哪里装，不再跑一条注定失败的命令。
- 装插件和加市场的下载跟着当前的加速线路走。

## 开发

- `electron/provider-extensions.ts`：`mutate` 在 Claude 插件安装前调用 `ensureClaudeOfficialMarketplace`——先用 `claude plugin marketplace list --json` 判断官方市场是否在册（命令失败时回落到读 `~/.claude/settings.json` 的 `extraKnownMarketplaces`），缺失才跑 `claude plugin marketplace add anthropics/claude-plugins-official`，超时给 240 秒（CLI 自己的缓存刷新与 clone 各 120 秒，更短会把它的解释换成一条通用超时）。
- 市场缺失的根因：官方市场只在 `claude` 首次交互式启动时注册，而本软件一律非交互 spawn CLI，共用同一个 `~/.claude`。
- `marketplace add` 依赖 git，装前用注入式 `findExecutable('git')` 探测，缺失时抛出分平台的中文提示（Windows 指向 git-scm.com，macOS 指向 `xcode-select --install` 或 Homebrew），失败原因经 `registerTrustedHandler` 照旧落 `runtime.jsonl`。
- 新增 `ProviderCliInvocationOptions.extraEnvironment`，由 `isNetworkBoundExtensionMutation` 判定的出网操作（非 MCP 的 install / update）与市场添加带上代理变量；`main.ts` 用 `subprocessDownloadProxyEnvironment` + `resolveProxy('https://github.com/')` 接线，沿用 #231 的回环代理约束。命令解析仍用不带代理变量的基底环境。
- `ProviderExtensionsSnapshot` 新增可选的 `marketplace`（`name` / `registered` / `reason`），让界面能分辨「没有可装的」和「市场还没加进来」；仅 Claude 填充，其余 Provider 缺省即旧行为。
- `provider-extensions.test.ts`：更新钉死的安装断言，补「无市场先加市场」「已有市场不重复加」「缺 git 报错且不发命令」「列表命令失败回落用户设置」「快照市场状态」「代理只给出网命令」等用例。

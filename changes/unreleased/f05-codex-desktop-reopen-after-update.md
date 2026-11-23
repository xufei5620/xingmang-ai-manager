## 开发

- 给客户看的那句并进了 `f03-mac-desktop-update-cancel.md`（0.2.25 更新说明统一改为正式书面口吻、同类并条，复查第三轮第 8 条）。
- 0.2.25 总单第 38 项（11-18 复核 F05）：Mac 上更新开着的 Codex 桌面端，星芒先关掉它、更新完替客户重开（`useDesktopAppUpdate` 的 `reopen`），
  重开走的是首页「打开」那条 `requestLaunch`。那一刻别的工具的「打开」还没走完（比如 Codex 命令行停在选目录），`requestLaunch`
  当成重复点击直接丢掉，桌面端就一直关着。
- `useToolLaunch` 新加 `requestLaunchWhenFree`：别的工具那次还在走（同一个账号、不是停在等账号那一轮）就排在它后面，那次走完在 `finally`
  里接着开；换了账号的不开，正在打开的就是同一个工具的不再叠一次，只排一个。`App.tsx` 里 Codex 桌面端的重开改走它，客户自己点的「打开」照旧。
  没加新字、没加通道。
- 用例 `testing/app-check.mjs`「macOS reopens the Codex desktop app after an update even if another tool was opening meanwhile」：
  夹具加 `codexMacUpdate`（Mac、桌面端开着、可更新到 v1.3.0，更新能压在半路）。旧代码上卡在等重开那一步红。

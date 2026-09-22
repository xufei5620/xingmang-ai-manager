## 用户

- 已登录状态下开机更快，内存尖峰更小：写完账号 Key 之后不再把整轮环境检测重跑一遍。

## 开发

- 开机（已登录）原本要跑三遍 `scanSystem`，其中两遍是强制：首屏 `useToolbox` 一遍（非强制）、`bootstrapAccountTools` 里一遍（`scanSystem(true)`）、Key 写完后 `App.tsx` 又 `refresh(true)` 一遍。现在降到两遍且都不强制。
- `useToolbox` 新增 `refreshConfig()`：只重读配置分区，不碰 `scanSystem`，也就不再起一轮探测子进程（Windows 上每遍光 Codex 桌面端就并发三个 powershell），不清主进程的 npm 最新版 / 网络位置 / 官方 ChatGPT 缓存。`App.tsx` 的 Key 同步收尾改走这条。
- 这条刷新不打断正在跑的扫描：照 `desktopRevision` 的既有套路加了 `configRevision` / `latestConfig`，让那遍扫描落地时用新配置顶替它开跑前读到的旧配置。首屏扫描已经失败、手上什么都没有时才回落到一次完整扫描（`planConfigRefresh`）。
- `bootstrapAccountTools` 的 `scanSystem(true)` 改成 `scanSystem()`：这份计划只读「装没装、探测有没有失败」，而安装状态从不缓存，force 清掉的几份缓存与它无关。
- 手动「重新检测」、装/卸工具、保存配置后的刷新仍是完整强制扫描，用户可见行为不变。

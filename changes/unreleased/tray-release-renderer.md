## 用户

- 窗口缩到托盘里久了，星芒会自己少占些内存；再点开时回到原来那一页。

## 开发

- 新增 `electron/renderer-release.ts`：主窗口缩在托盘里满 10 分钟、界面报告手上没事、主进程没在退出 / 装东西 / 付款，
  就用 `forcefullyCrashRenderer` 关掉界面进程省内存（窗口留着，Windows 关机询问、托盘照旧）；点托盘或任何入口叫出来时
  按原地址重新加载（Linux 上实测欢迎页约 0.3 秒回来）。界面没报告过忙闲的（legacy 回滚版）一律不关。主进程那一声「界面进程没了」
  不记成崩溃；关着和重新加载那一会儿托盘、系统通知、深链、platform「打开某页」要的跳页先存着，新界面第一次报告时再发。
- 界面经新通道 `window:report-activity` 报告忙闲：`background-work.ts` 登记聊天生成、视频制作、工具任务、登录后同步密钥，
  再加开着的对话框（对话框一开就报，Linux 上窗口藏起来不来 visibilitychange）。重新加载的那一次 `getWindowCapabilities`
  带 `rendererRestored`，界面回到关掉前停的那页（sessionStorage），不再弹开机提示、不再跑开机检查和检查更新，登录恢复那一轮静默；
  关掉过的更新气泡、维护提示、线路重启提示也记在 sessionStorage，不会重新冒出来。
- 「余额低于 5 美元」「花费突然变多」两个系统通知从界面搬到主进程（`balance-alerts.ts`、`spend-spike.ts`），界面关着也照常提醒；
  花费突增 6 小时内只提醒一次的记录从 localStorage 换成 userData 的 `spend-spike-notified.json`，升级后第一次最多多提醒一次。
- 新增 `electron/released-renderer-watch.ts`：界面关着时每 10 分钟读一次余额（托盘与上面两个提醒照旧），看缓存的公告，
  有界面没见过的新公告、或有充值活动（每天一次）就叫醒界面让它照旧弹公告；窗口仍在托盘，叫醒后再满 10 分钟又关。
- 已知小差别：重新加载后滚动位置不保留；关着时模板填写的失败重试暂停，叫出来再继续；只在界面里的事件关着时收不到，
  重新加载时会重新读一遍。

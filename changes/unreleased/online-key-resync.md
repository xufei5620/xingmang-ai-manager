## 用户

- 在没网的地方打开软件时，首页不再只说「账号 Key 初始化没有完成」，改成告诉你已装好的工具照常能用、联网后会自动补写 Key；网络一恢复，客户端自己再同步一次，不用再回首页点「重新同步」。

## 开发

- `src/renderer-v2/features/tools/online-resync.ts`（新增）：用 `electron/network-failure.ts` 的归类判断一次引导是不是被网络拦住（要求所有失败信号都是网络类，掺进 401 或分组问题就不算），并给出「联网后补跑一次」的纯状态机（每次离线→在线最多一次，补跑期间不重复排队，切号或退出登录即清空）。
- `account-bootstrap.ts`：`AccountBootstrapResult` 增加 `networkBlocked`，由 `syncError`、`syncManagedCliKeys` 的逐工具签发失败与逐工具配置失败三处信号算出；加密缓存与来源标记这类警告不参与判定。
- `App.tsx`：引导段每跑完一次就记下结论，并监听 `window` 的 `online` 事件按状态机补跑一次（仍走 `restore` 模式，已连接的工具照旧跳过），补跑再失败只写一行 `runtime.jsonl`，不弹任何对话框。
- `features/tools/Home.tsx`：网络类失败时横幅换成「当前网络不可用……联网后会自动补写 Key」，保留「重新同步」按钮。

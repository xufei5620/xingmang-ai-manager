## 用户

- 命令行工具和 Codex 桌面端的安装、更新现在可以中途取消：进行中的那一行会出现「取消」，
  点一下就停下正在跑的下载，已经下了一半的东西会自己清掉，工具还是原来的样子。
- 最后把新版本装进系统的那几秒不能中断，这时点取消会告诉你原因，等它结束就好。

## 开发

- 新增 `electron/install-cancellation.ts`：按操作名登记正在进行的安装，`cancel` 返回
  `{ cancelled, reason }`；不可中断的阶段调 `seal(原因)`，此时取消被拒绝并把中文原因回给渲染层。
  登记名与 `InstallationQueue` 的去重键一致，句柄在入队之前登记，排队等待中的安装也能取消。
- 新增两条 IPC 通道：`cli:cancel-install` 与 `desktop:cancel-install-codex`，各自紧跟对应的安装通道，
  `ipcInvokeChannels` 键顺序与 `ipc.ts` 注册顺序同步（T1）。
- CLI 侧：`executeNpm` 的每次 `executeCommand` 与 Grok 签名下载都带上 `signal`
  （`executeCommand` 本来就会在 Windows 上用 `taskkill /T /F` 连子进程树一起杀）；
  镜像回退循环在每次重试前检查取消，避免「点了取消只是换一条源接着下」；
  `replaceManagedNpmPrefixAtomically` 与 Grok 可执行文件替换两段 `seal`（I9、I11）。
  `grok-installer.ts` 的 `downloadLatestGrokBinary` 新增可选 `signal`，取消后不再试下一个镜像地址。
- Codex 桌面端：`downloadCodexDesktopPackage` 与 `downloadCodexDesktopPackageFromCandidates`
  新增可选 `signal`，取消后既不继续下载也不回落到上一版本；超时与取消在 catch 里分开判断，
  取消不会被说成「连接或下载超时」。`Add-AppxPackage` 与关闭运行中进程那一段 `seal`。
- 取消统一抛 `InstallCancelledError`，进度事件与 `runtime.jsonl` 都记成取消而不是失败。
- 渲染层：`useToolbox` 的 `run` 接受 `cancel` 回调并新增 `cancel(key)`，用户点过取消后吞掉那次拒绝，
  不再弹「安装工具没有完成」；首页工具行与「安装卸载」页在安装进行中显示「取消」。
- 下载与 npm 跟随系统代理的接线（#231、#238）未改动。

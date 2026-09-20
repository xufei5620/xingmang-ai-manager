## 用户

- 四个命令行工具的安装和更新现在可以中途取消：进行中的那一行会出现「取消」，点一下就停下正在跑的下载，
  已经下了一半的东西会自己清掉，工具还是原来的样子。
- 只有最后把新版本写进工具目录的那几秒不能中断，这时点取消会告诉你原因，等它结束就好。

## 开发

- 新增 `electron/install-cancellation.ts`：按操作名登记正在进行的安装，`cancel` 返回
  `{ cancelled, reason }`；不可中断的阶段调 `seal(原因)`，此时取消被拒绝并把中文原因回给渲染层。
- 新增 IPC 通道 `cli:cancel-install`（`ipc-contract.ts` 的 `cancelCliInstall`），按 `ipcInvokeChannels`
  的键顺序排在 `cli:install` 之后（T1）。
- `installCliOperation` 接受取消句柄：`executeNpm` 的每次 `executeCommand` 与 Grok 签名下载都带上
  `signal`（`executeCommand` 本来就会在 Windows 上用 `taskkill /T /F` 连子进程树一起杀）；
  镜像回退循环在每次重试前检查取消，避免「点了取消只是换一条源接着下」；
  `replaceManagedNpmPrefixAtomically` 与 Grok 可执行文件替换两段 `seal`（I9、I11）。
  取消统一抛 `InstallCancelledError`，进度事件与 `runtime.jsonl` 都记成取消而不是失败。
- `grok-installer.ts` 的 `downloadLatestGrokBinary` 新增可选 `signal`，取消后不再试下一个镜像地址。
- 渲染层：`useToolbox` 的 `run` 接受 `cancel` 回调并新增 `cancel(key)`，用户点过取消后吞掉那次拒绝，
  不再弹「安装工具没有完成」；首页工具行与「安装卸载」页在安装进行中显示「取消」。
- 下载与 npm 跟随系统代理的接线（#231）未改动。

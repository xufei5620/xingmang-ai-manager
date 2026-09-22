## 用户

- 安装或更新命令行工具、下载 Node.js 时，软件会自动启用加速线路，不再需要先去「游戏加速」
  里点连接。这条临时线路只用于下载，不会改动电脑的网络设置，下载结束自动关闭，加速页面也
  不会因此显示为已连接。
- 加速生效时优先从官方源下载；线路起不来就按原来的顺序下载，不会因此变慢或失败。正在使用
  游戏加速的，下载直接跟着现有线路走。
- 下载占用的时间不计入当前账号的免费加速时长；免费时长已经用完的账号不会再启用这条临时线路。
- 设置里固定过「下载顺序」的，仍然按你选的顺序来。

## 开发

- 新增 `electron/download-acceleration.ts`：下载临时加速协调器（按持有数计数、超时退化、
  只接受回环端点），与 `electron/download-proxy.ts` 的子进程代理过滤配套。不含 Electron
  依赖，可单测。
- `acceleration-development-backend.ts` 增加 `startDownloadRoute` / `stopDownloadRoute`：
  起内核但**不调用 `proxy.enable`**，因此不写系统代理、不进 `AccelerationState`，IPC 契约
  与渲染层一行未动。用户在下载期间点「连接」会接管同一个内核（同线路不重起），会话停止时
  若仍有下载持有内核则保留内核。`downloadRouteBillsFreeAllowance = false` 是计费开关；
  额度仍是门槛（用完不再起临时线路）。
- `main.ts` 用独立的内存分区 session（`xingmang-download-acceleration`）承载下载流量，
  租约生效时给它设回环代理，默认 session 不动；`resolveSubprocessProxyEnvironment` 在有
  临时线路时直接交出该端点。
- `system-service.ts` 把 `installCliOperation` 与 `installNodeRuntime` 整段包进
  `withDownloadAcceleration`，并让 `inspectNetworkRegion` 在加速生效时归约为 official-first
  （同时跳过区域探测）；用户钉死的 `mirrorPolicy` 优先级不变。

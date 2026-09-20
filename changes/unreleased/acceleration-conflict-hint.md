## 用户

- 开始加速前会检查系统代理和虚拟网卡，发现其他代理或 VPN 正在运行时先提示一句，你可以先关掉它们，也可以选择「仍然连接」。

## 开发

- 新增 `electron/acceleration-conflict.ts`：连接前只读地探测系统代理占用情况（Windows 走 `createWindowsSystemProxy` 新增的 `inspect()`，macOS 走 `/usr/sbin/scutil --proxy`），以及 Windows 上的 VPN 虚拟网卡名。macOS 的 utun 名对所有隧道一视同仁（iCloud 专线代理、接力都会建），据此判断 VPN 只会误报，所以那侧只判代理。
- 检测到冲突时 `startAcceleration` 直接返回带 `conflicts` 的状态，不写账本、不启内核、不动系统代理；渲染层据此给出提示与「仍然连接」，后者以 `ignoreConflicts` 重发同一次连接。契约里 `AccelerationConflictKind` 是封闭集合，探测细节（代理地址、网卡名）不跨 IPC、不进日志。
- 检测结果与用户的决定记进 `runtime.jsonl`：`acceleration.conflict.detected` / `acceleration.conflict.ignored`，沿用 `acceleration.start.failed` 的 stage 上报通道。
- 探测本身读不到时按无冲突放行，连接路径与检测存在前完全一致。

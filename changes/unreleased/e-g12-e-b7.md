## 用户

- 为 Codex 桌面端开启中文界面时，会先确认那个本机调试端口确实属于刚启动的 Codex；被别的程序抢占时直接放弃中文增强并提示，Codex 本身照常打开。
- Codex 桌面端安装或更新排队期间点“打开”，不再出现 Codex 刚起来又被装包关掉的情况，改为排在安装之后再打开。

## 开发

- Codex 桌面端中文注入前先按激活拿到的 PID 校验调试端口归属：新增 `resolveCodexDesktopCdpPortOwners`（`Get-NetTCPConnection -State Listen` 取 `OwningProcess`）与纯函数 `parseCodexDesktopCdpPortOwners` / `classifyCodexDesktopCdpPortOwnership`，端口未绑定则继续等待，出现非本进程的监听者则中止注入，拿不到 PID 一律不注入；端口分配的 TOCTOU 窗口因此不再可利用（E-G12）。
- `launchCodexDesktop` 改走 `installationQueue.enqueue`，键为 `desktop:codex:launch:<模式>:<是否中文>`：只靠 `codexDesktopInstalling` 布尔标志时，已入队但尚未开始的安装拦不住启动（E-B7）。

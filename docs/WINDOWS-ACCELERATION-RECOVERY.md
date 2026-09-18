# Windows 加速停止失败与现场恢复

## 2026-09-18 客户现场

客户使用 0.2.5，开启加速成功，停止后强退再打开。20:10 的诊断记录显示：旧辅助进程 PID 44300 的创建时间仍与代理租约一致，mihomo PID 44356 仍监听 57448，系统代理仍指向此端口。代理注册表只有 `ProxyOverride` 与启用时快照不同。新主进程已经启动，但旧辅助进程仍持有租约。

旧实现要求恢复时整个代理快照完全一致。绕过列表变化也会使恢复失败；为避免系统代理指向已停止的端口，软件保留内核，后台继续重试。旧辅助进程未退出时，新进程不能接管它的租约。旧 IPC 日志把成功返回 `stopping` 状态也记为“完成”，因此几条停止完成日志不能证明停止成功。

现有记录不能确定修改绕过列表的是 Windows、用户还是其他程序。首次账号库 `STORAGE` 错误出现在 18:40，早于本次 19:48 加速与 19:53 退出，不能把这次强退认定为原账号损坏的原因。账号密文认证失败的恢复见 [ACCOUNT-VAULT-RECOVERY.md](ACCOUNT-VAULT-RECOVERY.md)。

## 软件修复

- 仅绕过列表发生变化时，按字段保留用户后来的 native bypass / registry `ProxyOverride` 修改，恢复原代理、PAC 和 flags。写入前继续比较完整当前快照，写后完整回读；写入失败保留恢复记录。
- 其他代理字段被更改时，不覆盖外部设置；如果仍依赖软件加速端口，则继续保持内核和恢复记录。
- 内核已经退出但配置清理失败时，后续停止仍调用幂等清理，成功前保持 `stopping`。
- 停止返回尚未完成的状态时，IPC 记录警告。诊断只记录 `proxy-restore`、`core-stop`、`ledger-write` 阶段，不输出底层错误中的配置和凭据。
- 打包辅助进程从启动时使用独立 Electron profile，并在入口设置独立 `userData` / `sessionData`，避免和主程序共享 `Local State`。这是对已确认共享风险的修复，不是对客户密钥变化来源的证明。
- 初始化失败后，只有旧辅助进程确认退出才允许重建，避免仍在恢复网络时启动第二个进程争抢租约。

## 已安装旧版的临时恢复

把 `scripts/windows-acceleration-recovery.ps1` 复制到**客户实际桌面**，文件名保持不变。先从托盘退出星芒软件，再在客户原 Windows 用户的 PowerShell 中运行：

```powershell
$desktop = [Environment]::GetFolderPath('Desktop')
$script = Join-Path $desktop 'windows-acceleration-recovery.ps1'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script -Apply
```

不带 `-Apply` 时只检查。脚本始终尝试将报告保存为桌面的 `xingmang-proxy-recovery-时间-随机值.txt`，包括失败原因；使用 UTF-8 无 BOM。脚本源文件为 ASCII 兼容的 UTF-8，可直接通过 Windows PowerShell 5.1 `-File` 运行。

恢复前验证租约和完整代理状态，在同目录排他创建并落盘 `proxy-recovery-backup-时间-随机值.json`，然后通过 WinInet 恢复开启加速前的配置并保留后来的绕过列表修改。现场原代理为另一个本地端口，所以不使用“一律禁用代理”的处理方式。

脚本与软件使用同一个当前用户命名互斥锁；不终止进程，不删除租约、账号文件或 `Local State`。恢复记录交给旧辅助进程继续清理内核、配置和计时账本。恢复完后重新打开软件。

报告关键结果：

- `PREVIOUS_PROXY_RESTORED`：原代理已恢复并完成回读；`WorkerJournalCleaned` 表示等待期间旧进程是否完成清理。
- `OWNED_PROXY_ALREADY_RELEASED`：当前代理已不依赖记录里的加速端口，没有执行写入。
- `NO_RECOVERY_JOURNAL`：当前没有代理恢复记录，没有执行写入。
- `FAILED`：查看固定 `Reason` 代码继续排查；不自动删除文件或强杀进程。

## 验证范围

Windows 代理和后台停止测试使用模拟系统调用，不更改开发机的系统代理。客户脚本在真实 Windows PowerShell 5.1 中编译 WinInet 互操作代码，33 项模拟检查验证绕过列表保留、原代理恢复、并发编辑拒绝、失败回滚及重试；另外使用临时 APPDATA 和模拟 WinInet 完整验证只读/恢复入口、先备份后写入、保留恢复记录以及桌面 TXT 导出。

真实 Electron 43.6.0 临时目录冒烟测试还验证了两个并发辅助进程各自拥有独立的 `Local State`，主程序的 `Local State` 字节不变，重启后合成账号密文仍能解密。`npm run typecheck` 的四套配置检查通过。

```powershell
npx vitest run electron/platform/windows-system-proxy.test.ts electron/acceleration-development-backend.test.ts electron/acceleration-development-host.test.ts electron/acceleration-electron-profile.test.ts electron/acceleration-worker-entry.test.ts electron/ipc.test.ts --no-file-parallelism --testTimeout=30000
node --test scripts/windows-acceleration-recovery.test.cjs
node e2e/acceleration-profile-isolation-smoke.mjs
npm run typecheck
```

源代码修复需要打包并更新客户安装后生效；恢复脚本用于处理客户当前旧版本遗留的代理状态。

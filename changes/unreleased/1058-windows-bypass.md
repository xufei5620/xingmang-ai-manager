## 开发

- Windows 系统代理绕过列表补私网段（#1058 第 2 项后半）：`windows-system-proxy.ts` 的 `buildWindowsLoopbackProxySnapshot` 从 `<local>;localhost;127.0.0.1;[::1]` 改成再加 `10.*`、`172.16.*`～`172.31.*`、`192.168.*`、`169.254.*`，跟 #1121 给加速内核加的局域网直连对上。WinInet、Chrome、Firefox、.NET 读这份列表只认通配不认 CIDR；`100.64.0.0/10` 和 IPv6 内网写不成短通配，仍只靠内核直连，同样不送去共享节点。客户自己原来的代理设置照旧原样还回去，开着加速时客户改过的绕过列表照旧保留。
- 恢复记录兼容：`parseJournal` 认的 `applied` 从一个固定快照变成两个——现在写的这份和 0.2.19 及以前写的那份（只差绕过列表）。老版本开着加速断电或崩溃、升级后再开，照样认作自己写的、照样还原；认不出来系统代理就一直指着没人听的端口。两边列表混写的快照不认。客户恢复脚本 `scripts/windows-acceleration-recovery.ps1` 的 `Assert-RecoveryJournal` 同样两份都认；卸载冒烟（`windows-uninstall-cleanup-smoke.ps1`）四轮里有一轮摆的是旧列表的恢复记录，其余三轮是新列表，真 WinInet 写入读回逐字一致；Windows PowerShell 探针补了新列表与混写两条。新加的单测钉住两个脚本里的列表和客户端一致。

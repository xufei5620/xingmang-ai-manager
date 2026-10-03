## 用户

- Windows 上开始加速、停止加速更快了：改系统网络设置前不用再先做一段准备工作，电脑慢或刚开机时这一步以前
  可能要多等十几秒，现在省掉了。卸载时把网络设置改回原样也一样。

## 开发

- `platform/windows-system-proxy.ts`：WinInet 互操作不再用 `Add-Type` 现编 C#，改成用 Reflection.Emit 在内存里
  声明三个系统函数（`InternetQueryOptionW`、`InternetSetOptionW`、`GlobalFree`，按 System32 全路径加载），
  `INTERNET_PER_CONN_OPTION_LIST` 按 wininet.h 的排布手工读写（指针宽度取 `[IntPtr]::Size`）。Windows PowerShell
  现编要起 csc.exe、往 %TEMP% 写 DLL 再载回来，每次调用都是第二个冷进程：Windows 打包检查里「查系统代理是谁设的」
  一项在 #745、#796、#805 三次超过 15 秒上限（#805 是 18.6 秒，同一轮其余 30 项都在 1 秒上下）。查进程身份
  （`owner`）现在完全不碰 WinInet；三个系统函数等读、写代理第一次用到时才声明。排布在 x86、x64、ARM64 三种 Windows
  目标上用 clang 的静态断言核过，读写往返、释放和失败路径在沙箱里用 PowerShell 7 加一个按同样结构体编译的
  替身库跑过；真机 WinInet 读写由 windows-uninstall-smoke 覆盖。
- `scripts/windows-acceleration-recovery.ps1` 跟着换成同一份助手函数，测试改为比对从 `Initialize-WinInet` 到
  `Same-State` 末尾的整段文字（原来只比对 C# 类型定义，`Read-State` / `Write-State` / `Same-State` 没人管）。
  读不出系统代理时，客户报告里的原因从 `unexpected-system-error` 变成 `proxy-query-failed`（同样是固定代码，
  不带系统原话）；写入失败照旧报 `proxy-restore-not-confirmed`。
- `e2e/windows-powershell-probes-smoke.mjs` 加一项只读的「system proxy reading」，按 15 秒上限卡真正读系统代理的
  那条路，日志只打 flags。

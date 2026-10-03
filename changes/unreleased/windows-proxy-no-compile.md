## 用户

- Windows 上开始加速、停止加速更快了：改系统网络设置前不用再先做一段准备工作，电脑慢或刚开机时这一步以前
  可能要多等十几秒，现在省掉了。卸载时把网络设置改回原样也一样。

## 开发

- `platform/windows-system-proxy.ts`：WinInet 互操作不再用 `Add-Type` 现编 C#，改成用 Reflection.Emit 在内存里
  声明三个系统函数（`InternetQueryOptionW`、`InternetSetOptionW`、`GlobalFree`，按 System32 全路径加载），
  `INTERNET_PER_CONN_OPTION_LIST` 按 wininet.h 的排布手工读写（指针宽度取 `[IntPtr]::Size`），WinInet 会读的
  字段逐个写，不用 `Marshal.Copy` 拷字节数组来清零。Windows PowerShell 现编要起 csc.exe、往 %TEMP% 写 DLL 再载回来，
  每次调用都是第二个冷进程：Windows 打包检查里「查系统代理是谁设的」一项在 #745、#796、#805 三次超过 15 秒上限
  （#805 是 18.6 秒，同一轮其余 30 项都在 1 秒上下；#807 之后 0.5 秒）。查进程身份（`owner`）现在完全不碰 WinInet；
  三个系统函数等读、写代理第一次用到时才声明。排布在 x86、x64、ARM64 三种 Windows 目标上用 clang 的静态断言核过，
  读写往返、释放和失败路径在沙箱里用 PowerShell 7 加一个按同样结构体编译的替身库跑过（分配的内存先填满垃圾）；
  真机 WinInet 读写由 windows-uninstall-smoke 覆盖。
- 退路：在内存里声明 P/Invoke 也是攻击工具不落盘的惯用写法，杀毒软件可能拦它，而 GitHub 的 Windows runner 关着
  Defender 的实时、行为和脚本扫描，CI 看不出来。所以这份脚本以非零退出码结束时（被脚本扫描拦下、进程被结束、读写出错
  都算，不看报错文字），同一个请求马上改用 `windowsSystemProxyCompiledScript` 再跑一次，之后同一个加速辅助进程都用它
  （辅助进程空闲两分钟退出，下次拉起会先再试内存声明）；它和 0.2.14 跑的脚本逐字节相同，测试用 SHA-256 钉住。超时
  不重跑，退路脚本失败也不再重跑。两份脚本都只在系统代理整份状态还等于请求预期时才写，重跑不会覆盖前一次留下的写入。
- `scripts/windows-acceleration-recovery.ps1` 保持 0.2.14 原样（客户手动跑、不限时，用不着内存声明）。它和软件
  退路脚本的比对从只比 C# 类型定义扩到再加 `Read-State` / `Write-State` / `Same-State`。
- `e2e/windows-powershell-probes-smoke.mjs` 加一项只读的「system proxy reading」，按 15 秒上限卡真正读系统代理的
  那条路，日志只打 flags；再用退路脚本读一次，和内存声明读出的逐项比对，耗时只打印、不卡上限；最后打印这台 runner
  上 Defender 的状态（实时保护、行为监控、脚本扫描、检出记录条数），只打印。

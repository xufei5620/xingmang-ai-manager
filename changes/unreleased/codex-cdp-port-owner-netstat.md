## 用户

- Windows 上用中文界面打开 Codex 桌面端时，换中文前那道「端口是不是 Codex 自己的」核对改用系统自带的轻量命令，
  不再每次先启动 PowerShell。电脑慢时，这一步以前可能拖长「正在把它的界面换成中文」的等待，最后还提示
  「未确认中文界面生效」。

## 开发

- `electron/codex-desktop-cdp.ts`：中文注入前核对调试端口归属，从 PowerShell 的 `Get-NetTCPConnection` 换成
  System32 下的 `netstat.exe -a -n -o`（`windowsSystemExecutable` 给绝对路径，`trustedCommandEnvironment`，
  `execFile` argv 数组，单次 10 秒限时不变，输出上限 8 MB）。两者读的是同一张 TCP 归属表。旧写法是 Windows 打包
  检查里唯一走 NetTCPIP 模块和 WMI 网络连接提供程序的探针：2026-10-03 的 44 轮 windows-package 里中位 1.1 秒，
  6 轮超过 3 秒，#796（10.4 秒）、#816（10.0 秒）两轮超过上限被杀，这 44 轮里同样走 CIM 查进程的三项最慢 1.3 秒
  （10-1 #745 也是这一项）。具体卡在系统哪一层，CI 日志看不出来。
- 解析照旧「查不清就不放行」：只认本地端口相同、且远端是 `0.0.0.0:0` / `[::]:0` 或状态是 `LISTENING` 的 TCP 行
  （德文等系统的状态列会翻译，地址不会）；IPv4、IPv6 和任意本地地址上的监听者都算，只要有一个不是 Codex 就判
  被占用；监听行读不出 PID（缺列、PID 为 0）整次查询算失败，不当成没有监听。`TIME_WAIT`（PID 0）、已建立连接、
  别的进程从同一端口号连出去的行都不算监听。旧写法会把 PID 0 的监听行直接丢掉，新写法更严。
- 不靠表头和英文状态词：表头不读，认监听看远端地址（`LISTENING` 只是多一种认法），PID 取最后一列。中文版 Windows
  的表头按控制台代码页（GBK）写出，经 `execFile` 按 UTF-8 解码后是一串替换字符；德文版连状态也翻译（`ABHÖREN`，
  850 代码页）。单测按这两种系统写出的原始字节、再照 `execFile` 的方式解码来造样本（照格式手写，不是从真机抓的），
  并让中文、德文两张表走完整个换中文流程。一行 TCP 都认不出来的输出算这次没查到（Windows 自己总在 135 等端口上
  监听，不会是空表），连续三次就放弃，不再当成「没人监听」白等满 20 秒。
- `e2e/windows-powershell-probes-smoke.mjs`：这项不再对着没人监听的 1 号端口查，改成真开端口：本进程监听并先
  关掉一条连接留下 `TIME_WAIT`，另一个进程从 127.0.0.2 用同一端口号连进来（不该算），第三个进程在 `[::1]` 上
  监听同一端口（该算），每次查询都按 App 给的 10 秒卡。runner 上建不出 127.0.0.2 连接或 IPv6 监听时只打印、跳过
  那一步。`powershell-module-imports` 的测试清单和 cmdlet 表去掉这条脚本与 `Get-NetTCPConnection`。

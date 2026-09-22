## 用户

- 更新或回到推荐版本时，如果这个工具还开着，现在会在开始前提醒一句「检测到它正在运行，建议先关掉窗口」。
- 因为文件被占用而失败时，提示改成「工具正在运行 — 先关掉正在使用这个工具的窗口，再重试」，不再说成「安装被杀毒软件拦住了」。

## 开发

- 新增 `electron/cli-process-probe.ts`：更新与回滚前按这个 CLI **自己的 npm 包目录**匹配运行中的进程（Windows 走
  `Get-CimInstance Win32_Process`，由 `resolveWindowsPowerShellExecutable` 给出绝对路径并经 `trustedCommandEnvironment`
  净化，目标目录用环境变量 `XINGMANG_CLI_PROCESS_ROOT` 传入、只用 `.StartsWith`/`.IndexOf` 比较，不拼进脚本文本也不做正则；
  macOS 走 `/bin/ps -xo pid=,args=` 只列当前用户）。匹配进程镜像或命令行是否落在包目录内，所以 `node` 进程本身、
  同一个全局前缀下的其他 CLI、用户自己另装的一份都不会被算进来。命令行只在 PowerShell 里参与过滤，不跨进程边界（I13）。
- 检测只用来把话说对：命中只在安装对话框里多一行提醒，不拦更新；失败、超时、被拒都归 `unavailable`，写进 `runtime.jsonl`
  （`cli.running-processes.probe`）后照常继续。
- `src/renderer-v2/registry/errors.ts` 新增 `toolRunning`（「工具正在运行」），`operation-error.ts` 把 `EBUSY` / `ETXTBSY` /
  `resource busy or locked` / 「文件被占用」/「正被…占用」从 `installBlocked` 拆出来，排在 `permission` 之前；`installBlocked`
  只留真的在说杀毒软件的说法。顺带把 `codex-sessions.ts` 那句「会话文件正被其他程序占用」也从「杀毒」挪到这一类。
- `system-service.ts` 的 `installCliOperation` 在托管目录原子替换失败、以及所有 npm 源都失败时，调
  `describeOccupiedCliFailure` 重数一次进程：`EBUSY` / `ETXTBSY` 自己就足以改写成「文件被占用」；`EPERM` / `EACCES`
  两说，只有真数到这个工具的进程才改写，数不到就让「需要管理员权限」原样出去。`ManagedNpmRollbackError` 不改写，
  它的 `preserveTransaction` 与渲染层「不套安抚文案」都依赖原话。
- Grok 走原生更新通道，不做这项检测。同样没有覆盖的还有非 npm 来源（官方安装器 / PATH 其他来源）的安装，
  那些本来就不出 npm 更新按钮。
- 测试：`electron/cli-process-probe.test.ts` 在非 Windows 上真起两个进程验证「只认包目录里那一个、不认普通 node」；
  Windows 专有两条——占住文件句柄后对同名目录做更新路径里的 `rename`，断言归到 `toolRunning`（不钉 errno，
  目录改名遇到被持有的文件在 Windows 上可能报 `EBUSY` 也可能报 `EPERM`）；另一条跑真实 PowerShell 探测脚本。
  Linux 允许重命名含打开文件的目录，所以这两条在沙箱里 skip。

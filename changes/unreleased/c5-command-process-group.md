## 开发

- 深查 C-5（CLI运行解析）：Mac / Linux 上命令超时、取消或输出超限时，`command-runner.ts` 原来只给直接起的那个进程发 SIGTERM、500 毫秒后 SIGKILL，它拉起来的孙进程（`claude mcp list` 起的 MCP 服务、`claude plugin marketplace add` 背后的 `git clone`、npm 的子进程）被 1 号进程收养后一直在后台跑。现在非 Windows 上 `runCommand` 起进程时带 `detached: true`（自成一个会话和进程组），`stop()` 用 `process.kill(-pid)` 给整组发信号，宽限期满再给整组 SIGKILL；这个 SIGKILL 的定时器不随命令结算一起清掉，所以直接子进程先退了、孙进程不理 SIGTERM 的也收得掉。整组发不出去（组已经没了、或一个都没权限）时退回原来只杀直接子进程。Windows 照旧走 `taskkill /T /F`，起进程的参数也不变。
- 自成一组以后命令不再跟星芒同组，星芒退出时还没跑完的命令由 `process.once('exit')` 挂的 `stopLiveCommandGroupsAtExit` 整组发一次 SIGTERM（只发给还没结算的那些，不碰已经正常跑完的命令留下的后台进程）。开发时在终端按 Ctrl+C，信号也不再直接传到正在跑的命令，要等星芒自己退出时这一步收掉。
- 测试替身：`CommandRunnerDependencies` 加可选的 `signalProcessGroup`。换了 `spawnProcess` 又没给它时照旧只杀直接子进程、不带 `detached`，假进程的 pid 不会变成发给真进程组的信号。`command-runner.test.ts` 新增真起孙进程的三条（取消、孙进程不理 SIGTERM、退出时收掉；在改之前的代码上都红）和替身的四条（整组先 TERM 后 KILL、整组发不出去退回、替身不发真信号、Windows 不变）。

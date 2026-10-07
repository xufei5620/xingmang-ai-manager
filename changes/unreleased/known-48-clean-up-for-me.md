## 用户

- 卸载 Claude Code 或 Grok CLI 时有文件没能自动删掉（比如工具还开着），弹出的框里多了「帮我清理」：点一下，星芒再核对一遍就替你删掉，
  不用再自己复制命令去执行；还有删不掉的，框里会说还剩几个、接下来怎么办。
- Mac 上卸载 Grok CLI 后按规矩留下的那几个旧文件，现在也可以在框里点「帮我清理」删掉。

## 开发

- 已知48「帮我清理」：新增 IPC `cli:clean-uninstall-leftovers`，只收工具名。卸载走到 manual-required 时，新模块 `uninstall-leftovers.ts`
  的 `captureUninstallLeftovers` 当场把手动命令里那几个文件记在主进程（所在目录的 dev/ino/mode/uid，文件的 dev/ino/mode/uid/gid/nlink/
  大小/mtime/birthtime，链接另记链接内容），记住了才给 `manualHelp.cleanUpAvailable`；硬链接、目录、别的账户的文件、经链接到达的目录、
  Windows 上的链接一开始就不记。点了以后 `removeUninstallLeftovers` 只删记下的那几个，删前再核一遍：目录换了或文件改了不删，同名已换成
  别的文件当作已删、不碰，重装后命令又指回它的程序文件不删（Grok 的 npm 安装脚本见到同版本 grok-<版本> 就沿用、只把链接指回去）；
  删不掉的留在记录里等下一次，返回还剩几个。
- Mac 上卸 Grok 原来只删命令入口，改名后的链接和程序文件一律交给客户手动删。yoyo 2026-10-06 打字同意「Mac 也帮我清理」后，
  「帮我清理」在 Mac 上也删这些，但只在 `isDarwinForeignWritablePath` 判定除 root 和当前用户外没人能改的目录里删（记录时、删前各查一次）。
  Windows、Linux 删的就是各自卸载本来就会删的那几个文件，没有放宽。
- `system-service.ts`：清理排安装卸载同一个队（key `cli:clean-leftovers:<工具>`），下一次卸这个工具时或清干净后丢掉记录；有删不掉或
  重装后在用的记 `cli.uninstall-leftovers.cleaned`（路径脱敏）。`DarwinGrokRetainedPathsError` 带上 `retainedPaths`。
- 界面：`ManualUninstall.tsx` 的标题、说明、「帮我清理」按钮、「清理好了。」与没删干净的红字照 yoyo 批的字，没有命令时的框不变；
  首页和安装卸载页都接上。`app-check.mjs` 加两条（点一次剩一个出红字，再点删干净关框），`uninstall-leftovers.test.ts` 与
  `system-service.test.ts` 钉住核对规则，`ipc.test.ts` 钉住新通道不收界面带来的路径。

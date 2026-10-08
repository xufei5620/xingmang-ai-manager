## 用户

- Windows 上卸载官方安装器装的 Claude Code 时如果它还开着，以前星芒说卸完了，正开着的那个程序文件却悄悄留在电脑里。现在卸完会弹出「Claude Code 还有文件没删干净」，提醒先关掉所有 Claude Code 窗口，再点「帮我清理」删掉它。

## 开发

- Windows 上卸官方安装器装的 Claude Code 时，开着的 `~/.local/bin/claude.exe` 改名成 `.claude.exe-<uuid>.removing` 能成、删不掉，
  `uninstallVerifiedNativeCliFiles` 把它放进 `retainedQuarantineFiles`，但 `system-service.ts` 的 `uninstallNativeClaude` 只取
  `retainedVersionFiles`，结果卸载报 `uninstalled`、这个文件一直留着，「帮我清理」也管不到（#935 末尾记下的那条）。
  新增 `buildClaudeRetainedFiles`：只在 win32 把改名后的命令入口一起算进要交给客户清理的文件，走 manual-required、
  进删除命令和「帮我清理」的记录；`buildClaudeRetainedVersionFilesReason` 多一个可选参数，有这类文件时换成先关窗口的那句说明。
  Mac 上按规矩留着的改名链接照旧不报。windows-latest 上加了一条用例：从 `claude.exe` 真起一个进程，核对卸载后它被改名留下、
  进程开着时清理删不掉、关掉后清理删得掉。

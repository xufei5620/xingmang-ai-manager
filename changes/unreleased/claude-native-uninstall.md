## 用户

- 在苹果电脑上用官方方式装的 Claude Code，现在可以在本工具里直接卸载了，不会再提示「已停止卸载」。
- 卸载官方方式装的 Claude Code 时（苹果电脑和 Windows 都一样），会一并删掉它留在电脑里的各个版本程序，不再白占磁盘空间；你的 Claude Code 设置和会话记录照旧保留。

## 开发

- Q14：官方安装器的 `~/.local/bin/claude` 在 macOS/Linux 上是指向 `~/.local/share/claude/versions/<版本>` 的符号链接，旧的 `uninstallNativeClaude`
  按单链接普通文件校验，报「不是单链接普通文件，已停止卸载」。新增 `electron/claude-native-uninstall.ts`：参照 Grok 在 macOS 上的做法建立符号链接卸载计划
  （链接身份与所有者钉住，realpath 必须正好落在当前用户的 `~/.local/share/claude/versions/` 下且是单链接普通文件，根目录 `~/.local` 身份钉住），指向别处一律拒绝。
- 命令入口移除后，逐个用 `uninstallVerifiedNativeCliFiles` 的普通文件路径删除 `versions/` 下名字是版本号的单链接普通文件（Windows 同样适用），再 `rmdir`
  空掉的 `versions/` 与 `~/.local/share/claude/`；不做按路径递归删除，`~/.claude`、`~/.claude.json` 完全不碰。删不掉的版本文件（被占用、硬链接、属主不符）
  以 `manual-required` 返回并附带可复制的清理命令。
- `native-cli-uninstall.ts` 新增可选 `allowAbsoluteSymbolicLinkTargets`（缺省 = 旧行为，只收相对目标），Grok 计划不受影响。macOS 上改名后的
  `.claude-<uuid>.removing` 链接仍按该模块既有约定保留，不按路径删除。

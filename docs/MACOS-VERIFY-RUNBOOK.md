# macOS 真机验证 Runbook · 第三轮（迷你，2026-08-09）

> 验证对象：二轮发现的三缺陷修复（agent 链自愈 / 卸载字节去重 / 历史隔离文件纳管）+ 顺带捎上的深度校验超时拆分。
> 本轮无紧急性，随时方便时验证即可。更新方式同上轮：`git fetch <bundle路径> local/integration:refs/remotes/bundle/local-integration && git merge --ff-only bundle/local-integration && npm ci`。

## 三个验证点

**1. agent 链自愈（核心）**
`rm ~/.grok/bin/agent`（保留 grok）→ 在应用里**只做一次扫描或「检查更新」，不点安装** → `ls -la ~/.grok/bin/` 确认 agent 链已被静默重建且与 grok 同目标。这验证的是：无论什么未知路径弄丢了 agent，下一次探测即恢复。

**2. 历史隔离文件纳管**
连续两轮「装→卸」且**不执行**清理命令 → 第三轮卸载时对话框应列出**全部**历史 `.removing` 文件且清理命令包含它们 → 执行命令后 `~/.grok/bin` 无残留隐藏文件、`downloads/` 分毫未动。

**3. 字节数与实际一致**
同版本重装（grok+agent 指同一目标）→ 卸载对话框「程序文件共约 X MiB」应为**单份**大小（此前虚报一倍的场景）。

可选加验：冷启动后首次刷新 Codex 桌面端状态，深度校验即使偏慢也不应再触发超时琥珀（预算已从 5s 放宽到 15s，其余探测仍 5s）。

## Mac 侧 Claude 粘贴提示词

> 你在 macOS 验证机上。先按上方命令把仓库更新到新 bundle 头并 npm ci，然后执行 docs/MACOS-VERIFY-RUNBOOK.md（第三轮）的三个验证点：第 1 点提示我删链后你观察重建；第 2、3 点引导我做装卸循环并核对对话框内容。完成后输出：每点 PASS/FAIL + 关键证据（ls 输出/对话框文案/字节数）。不要改代码、不要 commit/push。

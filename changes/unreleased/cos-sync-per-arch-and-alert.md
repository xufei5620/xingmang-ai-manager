## 开发

- Claude Mac 离线包同步从 2026-10-07 23:14Z 起每次在 `source-resolve` 失败：官方更新接口
  `api.anthropic.com/api/desktop/darwin/<架构>/squirrel/update` 改成按芯片给更新 ZIP
  （`downloads.claude.ai/releases/darwin/arm64|x64/<版本>/Claude-<id>.zip`），而
  `claude-mac-update-source.cjs` 只认 `darwin/universal`。现在也接受**与本次查询架构一致**的
  分芯片 ZIP，另一种芯片的地址照旧拒绝。我们同步的仍是同一版本、同一 release ID 的通用
  DMG/PKG：2026-10-10 在 GitHub runner 上实测 2.31226.1 的 `darwin/universal` 下 DMG/PKG/ZIP
  都在、`darwin/arm64|x64` 下的 DMG/PKG 是 404，所以 COS 索引格式和教程页都不用改。
- 两条官方离线包定时同步（`sync-claude-official-cos`、`sync-chatgpt-official-cos`）加了
  `alert` 作业（`scripts/cos-sync-alert.cjs`）：定时同步连续 2 次失败就开一条 issue、指派给
  仓库负责人；之后的失败只改这条 issue；下一次定时同步成功就留言并关闭。手动运行不算。
  只用本次运行的 `GITHUB_TOKEN`，作业级权限 `actions: read` + `issues: write`，不碰 COS
  凭据，不接外部服务。起因是 Codex 同步 10-04～10-09 连红 17 次、Claude Mac 连红 9 次以上
  都没人发现。
- Codex 那 17 次（`verify-windows-package` 报 `operation-failed`）10-09 22:36Z 在同一个
  commit 上自己恢复，推测是官方换了包；这次没有改它的校验。

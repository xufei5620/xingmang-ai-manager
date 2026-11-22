## 开发

- 给客户看的那句并进了 `remote-always-elevated-account.md`（「## 用户」合起来超了 60 条）。
- 手机遥控的权限分两档（yoyo 2026-11-22 北京 09:55 亲手打字同意放宽）：「默认」= `approvalPolicy: 'on-request'` +
  `workspace-write`，「只读」= `on-request` + `read-only`，不放完全访问，审批人仍是手机上的用户（`approvalsReviewer: 'user'`）。
  以前一律 `untrusted` + `workspace-write`，改文件和大多数命令都要先在手机上回「同意」。
- 设置存在 `codex-remote` 设置的 `permission` 字段，只认 `'readOnly'`，缺省或别的值都按「默认」（老设置不用迁移）。
  新开的对话由 `buildThreadStartParams` 带上对应的 `sandbox`；已经开着的对话在换档后的下一条消息由 `turn/start`
  带上 `approvalPolicy`、`approvalsReviewer` 和 `buildRemoteSandboxPolicy` 给的 `sandboxPolicy`，跟换模型同一套做法。
- 新加主窗口通道 `codex-remote:set-permission`（入参只收 `'default'` / `'readOnly'`，`parseRemotePermission` 校验），
  手机遥控页「通用设置」在「干活的文件夹」下面加「权限」一行；教程「手机遥控 Codex」第三步的说明跟着改。

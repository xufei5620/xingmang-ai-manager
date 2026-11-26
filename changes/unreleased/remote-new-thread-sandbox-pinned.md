## 开发

- 手机遥控新开的对话跟中途换档、接已有对话用同一套沙箱（0.2.25 第三轮复查第 5 条）：`buildThreadStartParams` 的
  `config` 带上 `sandbox_workspace_write.network_access = false` 和 `sandbox_workspace_write.writable_roots = []`。
  以前 `thread/start` 只传 `sandbox: 'workspace-write'`，Codex 照客户 `config.toml` 的 `[sandbox_workspace_write]` 来，
  客户开过联网的，手机上不问就能联网，加过的可写文件夹也能改；中途换档（`buildRemoteSandboxPolicy`）却一律不开网、
  可写的只有这个文件夹。Codex 0.169.0 实测：`config.toml` 开了联网、加了可写文件夹，改前 `thread/start` 回报
  `networkAccess: true` 和那个文件夹，改后两样都没有；项目里的 `.codex/config.toml` 也压得住；客户自己设的
  `exclude_tmpdir_env_var` / `exclude_slash_tmp` 照旧保留（只会更严）。
- 新加 `startedSandboxExceeds`：`thread/start` 回报的沙箱比手机这一档宽（联网、能改文件夹以外、只读档却可写、
  完全访问或外部沙箱）时，这份对话记成 `exceeds`，第一轮 `turn/start` 带上这一档的 `sandboxPolicy` 降下来，跟接已有对话
  超出这一档时一样，日志记 `remote.thread-start-sandbox-wider`。回报认不出的不算宽：Windows 没开沙箱时 Codex 会把
  可写降成只读，不能因为认不出反倒用 `turn/start` 抬上去。

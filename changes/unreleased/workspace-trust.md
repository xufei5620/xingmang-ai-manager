## 用户

- 从首页「打开」进 Claude Code 和 Gemini CLI 时，不再先被英文的「你信任这个文件夹吗」拦一道：
  目录是你刚在本软件里选的，这一项已经替你填好了，点开直接进对话。Claude Code 的首次启动
  向导（选主题、看安全须知）也一并跳过。
- 只对你在本软件里亲自选的目录生效；你自己在工具里答过「不信任」的目录保持原样，不会被改。

## 开发

- `config-files.ts` 新增 `trustManagedWorkspace`：Claude Code 写 `~/.claude.json` 的
  `projects["<路径>"].hasTrustDialogAccepted` 与顶层 `hasCompletedOnboarding`，Gemini CLI 写
  `~/.gemini/trustedFolders.json` 的 `{ "<路径>": "TRUST_FOLDER" }`。两家的字段都没有官方文档，
  形态是 2026-09-21 用空 HOME + 伪终端走完 Claude Code 2.1.277 与 Gemini CLI 0.60.0 的首启向导
  后 diff 出来的，方法和结论记在 `docs/WORKSPACE-TRUST.md`。
- 写入照 `trustCodexWorkspaceInConfigText` 的形态：纯函数出内容、`executeFilePlans` 出事务
  （两阶段提交 + `.bak` + 回滚，I9），路径过 `assertSafeConfigPath` / `assertNoReparseComponents`
  （I8）。已有条目一律不动，不改就完全不写。
- 调用点在 `system-service.ts` 的 `launchProviderOperation`，在解析 CLI 命令之前。写不进去
  （文件损坏、只读、主目录被重定向）不阻塞打开，只往 `runtime.jsonl` 记一条
  `workspace.trust.failed`，原因先过 `redactHomeDirectory`（I13）；为此 `SystemServiceOptions`
  多了一个可选的 `runtimeLog` 依赖，由 `main.ts` 传入。
- `requireConfigText` 多一个可选的字节上限参数：`~/.claude.json` 会随会话历史长，2MB 会误伤，
  这条路径用 16MB，与 `provider-extensions.ts` 读同一份文件时的上限一致。
- 私有函数 `normalizeCodexWorkspaceKey` 改名为 `normalizeWorkspacePathKey`，现在三家共用。

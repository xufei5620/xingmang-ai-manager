## 用户

- macOS 上启动 Claude Code 前，会先确认它确实是 Anthropic 官方签名的程序，签名不对就拒绝运行并提示重新安装。
  Windows 上一直有这道检查，现在两个平台一致。

## 开发

- E-B6：`tool-installation.ts` 的 `resolveCliCommand` 为 darwin 上 `source === 'native'` 的 claude
  补上来源校验（此前落到兜底分支零校验，而 codex / grok 在同一位置已做 Developer ID 校验）。
  新模块 `electron/macos-claude.ts` 复用 `darwinDeveloperIdVerificationArgv`，把信任交给 codesign
  的退出码，团队号 `Q6L2SF6YDW` 逐字节取自官方分发的二进制（`@anthropic-ai/claude-code-darwin-arm64`
  与 `-darwin-x64` 2.1.278 的 CodeDirectory teamID 与 CMS leaf
  `Developer ID Application: Anthropic PBC (Q6L2SF6YDW)`），不是照文档抄的。
- 与 codex / grok 不同，这条路径**不做私有暂存**：那两者要在可变的版本链接树里绑定一次"选择"，
  而 native claude 解析后就是一个普通文件，校验的路径就是交给 spawn 的路径；剩下的竞态属于
  同 uid 主体，按 T5 不在 macOS 防御模型内，而该二进制有 200 MB 以上，每次会话复制一份代价过高。
  校验结果按文件身份（dev/ino/mode/size/ctime/mtime）缓存，避免每次解析都重新哈希整个二进制。

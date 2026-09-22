## 开发

- 核实并记录：Windows 上给 MCP 写的 `npx` 命令不需要包 `cmd /c`。Claude Code 2.1.277 与
  Gemini CLI 0.60.0 的 MCP stdio 传输走 `cross-spawn`（按 `PATHEXT` 解析后自动转
  `cmd.exe /d /s /c`），Codex CLI 0.155.1 的 `rmcp-client/src/program_resolver.rs` 用
  `which` crate 解析成绝对路径，Grok CLI 1.0.40 内置文档写明它自己解析。四家的依据、
  复核办法与「什么时候可以推翻这条」写进 `docs/CURATED-EXTENSIONS.md`。
- 加两条回归门禁防止以后误「修」：`provider-extensions.test.ts` 钉住四家的 MCP 安装 argv
  里不出现 shell 包裹，`curated-extensions.test.ts` 钉住随包清单的 stdio 条目保持跨平台中立。

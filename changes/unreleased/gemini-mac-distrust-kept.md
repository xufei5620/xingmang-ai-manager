## 开发

- Gemini CLI 在同一版下线（`gemini-cli-retired.md`），星芒不再打开它，原来的「用户」说明一并拿掉。
- `config-files.ts` 的 `trustGeminiWorkspaceInTrustedFoldersText` 找已有条目时按 Gemini CLI 0.62.0
  `normalizePath` 的规矩比：win32 与 darwin 不分大小写。以前 macOS 上的 POSIX 路径照原样比，对不上
  Gemini 写下的全小写键（`/users/alex/app`），于是在后面再加一条原大小写的 `TRUST_FOLDER`；Gemini 读回来
  同一文件夹后一条算数，客户选的 `DO_NOT_TRUST` 就被翻了，之后在 Gemini 里再选一次「Don't trust」也翻不回来
  （沙箱里把平台设成 darwin、用 0.62.0 自己的 `setValue` / `isPathTrusted` 跑过）。Linux 上 Gemini 分大小写，
  照旧。已经被翻过的文件不回头改。

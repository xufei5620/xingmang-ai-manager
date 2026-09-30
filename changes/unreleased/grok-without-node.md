## 用户

- Windows 上只装 Grok 不用再先装 Node.js：点「安装」直接下载 Grok，少一次系统管理员确认。以后装 Claude Code、Codex、Gemini 时缺的运行环境照旧会一并准备好。这种情况下 Grok 照常能用，只是没有「做完提醒你」和「干活时不让电脑睡」这两项。

## 开发

- `platform-capabilities.ts` 新增可选的 `cliNeedsNodeRuntime`（Windows 上 Grok 为 false，缺省 = 都要）；`planCliInstall` 收 `needsNode`，Windows 装 Grok 不再把 Node.js 排进同一次安装；新手引导对这种工具不显示也不等「运行环境」那一行（第十八批 8）。

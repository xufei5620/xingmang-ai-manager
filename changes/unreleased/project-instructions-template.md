## 开发

- 新建项目文件夹里生成的说明文件 `bundled-catalog/project-instructions/AGENTS.zh-CN.md`：开头注释去掉已下线的 Gemini CLI（D50，新手流程.md N11）；「怎么自测」加一句「在 Windows 的 PowerShell 里调用 npm、npx、pnpm 时，写成 npm.cmd、npx.cmd、pnpm.cmd。」，让 AI 绕开 PowerShell 默认执行策略对 `npm.ps1` 的拦截，不碰安全设置（D75 选 a，Shell差异.md SH-4）。只对以后新生成的目录生效，已经生成的不动。新版摘要追加进 `PUBLISHED_PROJECT_INSTRUCTIONS_DIGESTS`，#288 那一版照旧留着，检查页仍认得老客户个人文件夹里没改过的那份；`project-instructions.test.ts` 钉住两版摘要和新字。

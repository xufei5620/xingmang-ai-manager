## 用户

- 外接工具页、插件页上的「读取失败」不再是英文原句了：以前显示的「Command timed out: claude」「Command exited with code 1: gemini」现在是「命令执行时间过长，已中止：claude」「命令执行失败（退出码 1）：gemini」，并且把命令自己输出的最后几行一起带上，一眼能看出是哪一步出了问题。

## 开发

- `electron/command-runner.ts` 的 `errorMessage` 七句默认文案改中文（第八批候选 3）。`code` 字段没动，`system-service.ts` / `external-client-runtime.ts` / `workbuddy-installer.ts` / `node-runtime.ts` 里按 `code` 分支的翻译层不受影响。
- 「超时」二字刻意不用：`src/renderer-v2/operation-error.ts` 的 `networkFailure` 认这两个字，本地 CLI 卡住会被归成网络失败、套上「连不上星芒服务器」。`TIMED_OUT` 因此写成「命令执行时间过长，已中止」。
- `electron/provider-extensions.ts` 的 `errorDetail` 对 `CommandRunnerError` 追加 stderr（没有就用 stdout）最后三行、截 240 字；这两份输出在构造 `CommandRunnerError` 时已经过 `redactCommandText`（I13）。受益的是 MCP 配置 / MCP 列表 / Skill 目录 / 插件市场 / 远端版本这几处 `warnings`。
- `command-runner.test.ts` 新增一条门禁：`errorMessage` 的七条返回值必须都含中文，加一个 code 忘了翻译会当场红。几处用英文原句造 `CommandRunnerError` 的测试夹具一并改成实际会产生的中文。

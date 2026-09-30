## 用户

- 装着 Codex 桌面端 26.924.2738.0 的电脑，首页 Codex 桌面端那一行会直接说明这一版在一些电脑上打不开、是 Codex 自己的问题，等微软商店出新版会自动好，急用先用 Codex 命令行版。
- 从星芒打开这一版没打开时，提示框直接说清楚是这一版的问题，并多一颗「改用 Codex 命令行版」：没装命令行版就直接开始装，装好了回首页点「打开」就能用。

## 开发

- 第十九批 7（只做提示，不做「退回上一版」）。新增纯模块 `electron/codex-desktop-known-issues.ts`：`codexDesktopKnownBrokenVersions` 表（目前只有 26.924.2738.0，上游 openai/codex #48946）+ `resolveCodexDesktopKnownIssue`（商店包版本与应用版本任一命中，末尾 `.0` 不影响）+ 两句文案；已登记进 `scripts/verify-renderer-boundary.test.cjs` 的 valueImportable。
- `describeCodexDesktopLaunchFailure` 多收可选的 `knownIssueVersion`，命中时在「等了 N 秒…」后接已知问题那句，替换「去开始菜单自己分辨」；内置 Administrator / 关了用户账户控制仍优先。渲染层 `operation-error.ts` 按 `codexDesktopKnownIssueMarker` 归到新类 `codexDesktopKnownIssue`（排在 `codexDesktopNotStarted` 前），按钮「重试 / 改用 Codex 命令行版 / 找客服」，新动作 `useCodexCli` 由 App 的 `switchToCodexCli` 处理（回首页；命令行版没装就开始装）。
- `model.ts` 的 `codexDesktopVersionAdvice` 不再对桌面端写死 null：命中已知问题表时给一份只有 `blockedReason`、没有推荐版本和退回的建议，首页桌面端那一行显示它。`codex-desktop-service.ts` 里「已装电脑不退旧版」的护栏没动。
- 上游出新版、真机核过能打开之后，下一版把表里那一行删掉（见 `docs/CLI-VERIFIED-VERSIONS.md` 末节）。没在真机上演过。

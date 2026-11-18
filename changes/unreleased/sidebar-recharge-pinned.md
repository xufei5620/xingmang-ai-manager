## 开发

- 侧栏「充值」从 `registry/shell.ts` 第三组挪进 `Shell.tsx` 的 `.v2-sidebar-pinned`，顺序是充值、更新入口（有新版时）、设置。加了画布、视频剪辑以后滚动区长了约 70px，逻辑高 Windows 约 740、Mac 约 770 以下最下面一组先被滚出去，充值排第一个，586 高时 Windows 半截压在渐隐下、Mac 整个滚出去。`keyboard.browser-check.mjs` 补两系统 586 高下充值看得见、没被盖住的检查（改前两条都红），`Shell.test.tsx` / `app-check.mjs` 钉住钉住区的新顺序；ui-spec 03 §3、v4 README、ui-spec CHANGELOG 跟着改。

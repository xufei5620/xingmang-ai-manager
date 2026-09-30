## 用户

- 切换账号时，原本就在用账号密钥的工具默认会一起换过去，切完不会再花上一个账号的钱。自己填的密钥默认不动，想换就手动勾上；不想换的取消勾选就行。
- 密钥页最上面写清楚了：工具用的密钥在首页安装或打开工具时会自动准备好，一般不用来这里手动建。列表是空的时，主按钮改成「去首页配置工具」。新建密钥时，「分组」和「可用额度」各加了一句说明。
- 外接工具、技能、插件三页一进来，默认显示你已经装好的那个工具，不再固定是 Claude Code。
- 运行环境装好后要重启电脑的，关掉提示框以后页顶会一直挂着「还差重启一次电脑」，旁边有「现在重启」，重启前不会忘。
- 「安装卸载」页里已经装好的运行环境不再显示「安装」按钮，并说明装工具时会自动准备，一般不用单独点。

## 开发

- 新手引导梳理（2026-09-25）第 1、4、5 条和第 3 条的默认工具部分。
- `SavedAccounts.tsx`：勾选状态改成只记用户改过的项（`choices`），由 `defaultSyncSelection` 现算：`reason === '星芒密钥'` 的默认勾，手填密钥默认不勾，不可同步的一律不算；「同步到工具」默认展开。`app-check.mjs` 两条切换账号的浏览器用例改为先取消 Gemini、Grok 再断言只写 Claude、Codex。
- `pages-account.tsx`：密钥页顶部加说明和「去首页配置工具」（`onGoHome` 取自 `onBack`），空列表主按钮同上，「新建密钥」降为普通按钮；分组、额度加 hint。
- `pages-management.tsx`：`preferredExtensionProvider` 按导航顺序挑第一个已装 CLI；`App.tsx` 从 `toolbox.snapshot.system.clis` 算 `installedProviders` 经 `BusinessPage` 传入；检测结果晚到时跟上，用户点过就不再换。
- `features/tools/restart-reminder.ts`：内存里记「还差重启」（故意不落盘，理由见注释），`RuntimeRestartDialog` 挂载时标记，`RestartReminder` 放在 Shell 的 banner 槽里。`pages-maintenance.tsx` 运行环境已装且不需换新版时不画按钮。

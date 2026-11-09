## 用户

- 卸载星芒后再装回来，Claude Code、Codex、Grok 的做完提醒、干活时不让电脑睡着和 Claude Code 底下那行状态栏，
  打开星芒时自己补回来，不用再重新保存一次配置。你自己删掉的提醒、自己设的状态栏不会被改。

## 开发

- 深查「安装卸载」第 1 条：Windows 卸载清理（`uninstall-cleanup.ts`）和 Mac「卸载星芒」（`macos-uninstall.ts`）
  收回钩子、状态行时，把收回了哪几家、哪几样、哪份文件记进数据目录的 `cli-hooks-removed-by-uninstall.json`
  （新模块 `removed-cli-hooks.ts`，读写走 safe-local-data）。重装后开机（以及开机后第一次读配置之前）由
  `config-save-service.ts` 的 `restoreCliHooksRemovedByUninstall` 按记录补回（`config-files.ts` 的
  `restoreManagedCliHooks`：只补现在没有的，已有的、客户自己的 statusLine / Codex notify 不动，先备份再写），
  补上或已经有了就划掉，写不出来的留到下次开机。只认这份记录，客户自己删掉的不补；Gemini CLI 已下线不记不补。
  这一版之前的卸载程序不写记录，已经卸过重装的电脑不在其内。

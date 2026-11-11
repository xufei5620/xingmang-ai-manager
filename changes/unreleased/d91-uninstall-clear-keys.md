## 开发

- D91（决定单 X42）：卸载时多一个勾「同时删掉这台电脑上存的密钥」，默认不勾，跟「同时清除登录记录和聊天记录」各管各的。
  以前清登录记录不碰工具配置和备份里的密钥，下一个用这台电脑的人打开 Claude Code 照样花原来账号的余额。
  勾上以后由 `uninstall-cleanup.ts` 新的 `clearStoredKeys` 删：Claude Code、Codex、Grok（连同已下线的 Gemini）
  的配置只要指着星芒的任一站点、任一线路，就按首页「切回官方账号」同一条路收回（`switchProviderToOfficialAccount`，
  第三方中转和客户自己的设置不动），再删掉这几份配置旁边由星芒写配置留下的 `.bak.<17 位时间>` 副本和 Codex 的
  `xingmang-auth-apikey.json`；画图技能里的密钥（只认带 `.xingmang-managed.json` 的、新加 `countXingmangAiSkillSecrets`
  核对确实清空）；数据目录里两个账号域的 `managed-cli-keys.dat`、`chat-group-keys.dat` 和读坏挪开的 `.corrupt-<毫秒>`；
  整个配置备份文件夹 `backups/`（`backups.ts` 导出 `configBackupDirectoryName`）。删文件都走 `removeSafeDataFile` /
  `removeOwnedTree`，链接、硬链接、联接一律不跟、不删（I8）。一样删不掉不耽误下一样，退出码多一位 `storedKeysRemain`（128）。
- Windows：卸载页欢迎页加第二个勾（`build/installer.nsh`），把 MUI2 欢迎页正文那块从 130u 截到 116u 给两个勾让位；
  勾上时卸载程序给清理多传 `--xingmang-clear-keys`（`uninstall-cleanup-entry.ts` 的 `uninstallClearKeysArgument`），
  静默卸载同一个开关在命令行上代替；两个开关先拼进 `$R1`，只拼编译期常量，仍只有一处 `ExecWait`。新开关跟清登录记录那个一样
  加进 `security.ts` 打包版 Windows 启动参数白名单（不在名单上带着清理参数会直接退出，清理根本不跑），`security.test.ts`
  按 `$R1` 的四种拼法逐条核对卸载程序的命令行都放得进来。清理在收回提醒设置之后、
  清登录记录之前跑；别的 Windows 账号装的那份照旧整个不碰（#498）。`windows-uninstall-cleanup-smoke.ps1` 加了只勾密钥、
  两个都勾、都不勾三种，核对密钥缓存、配置备份和 Claude Code 配置（连同 `.bak`）里的密钥按勾删或留。
- Mac：设置里「卸载星芒」的对话框加同一个勾（`AppUninstall.tsx`），`AppUninstallRequest.clearStoredKeys` 缺省不删；
  `macos-uninstall.ts` 只在程序确实挪进废纸篓以后才删（挪不动时人还要用，登录着的账号会把密钥写回去）。挪不动或没删干净
  都不在卸载提示里说（yoyo 11-11「这个不提示」），只记日志。
- 没覆盖：Claude Desktop、WorkBuddy、OpenCode 三个桌面客户端里星芒写进去的密钥，这一版不删。

## 用户

- 换了分组或账号、星芒自动把 Claude Desktop 和 WorkBuddy 换成新密钥时，会把它们用到的每个型号都对一遍，新密钥用不了的型号不再跟着换过去：Claude Desktop 打开时不会再因为菜单里留着新密钥没有的型号而提示型号被拒。

## 开发

- 深查·桌面端接入第 1 条：自动换密钥（#1113）原来只拿新 Key 的型号清单核默认那一个。Claude Desktop 开机检查挑的是菜单里的 Haiku（`claudeDesktopStartupCheckModel`），新 Key 没有 Haiku 时一打开就「型号被拒」；WorkBuddy 每条都换了 Key，不看各条的型号。
  现在 `claude-desktop-config.ts` 的 `followKey` 在写之前重读出来的那份上逐项核菜单，新 Key 不认的在同一笔写里拿掉（留下的项原样不动，默认那个不认就整笔不写）；`external-tool-config.ts` 的 `followExternalToolKey` 只换型号新 Key 认的 WorkBuddy 条目，不认的留着原 Key，一条都不认就不写。没跟过去的型号进 `external-client.key.followed` 日志的 `unsupportedModels`，不加界面文字。OpenCode 不变（只换当前型号那一份，调用方照旧核）。

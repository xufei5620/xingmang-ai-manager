## 开发

- Claude Desktop 开机补型号（yoyo 2026-11-12 回「1 2 3 做」第 1 条）：型号菜单原来只在客户点「保存配置」那一刻写（#1494），
  账号后来上的 Claude 型号要客户回星芒再保存一次才进得去。现在开机安静期过、登录恢复完再等 30 秒，主进程在后台
  （`external-client-route-service.ts` 的 `topUpClaudeDesktopModels`，`main.ts` 起）只对星芒替当前账号写的、正在用的、
  在当前线路上的那一份，按今天保存会挑的那几个（`claudeDesktopTopUpCandidates`）把菜单里还没有的照 Claude Desktop
  开机检查各发一个字，试通了的放到默认那个后面（`claude-desktop-config.ts` 的 `addModels`），原来的一项不删、默认不动，
  最多攒到 12 个。Claude Desktop 开着（或看不出开没开）这次就不补；写之前再盘点一次，试型号那几秒里打开了也不写。
  0.2.12 那串写法（#685）留给开机修复，不补；没写清单、由它自己问网关要的不补。
- 哪些算新上的记在 `<数据目录>/external-clients/claude-desktop-models/<配置编号>.json`（`claude-desktop-model-topup.ts`）：
  每次补完记下这把 Key 当时列着的型号，Key 只存摘要；下次只试记录里没有的，客户自己从菜单拿掉的、菜单满了放不下的不会
  每次开机又补回来。试过没通的不记，下次开机再试；菜单没写成（Claude Desktop 打开了、换了账号）这次也不记。换了 Key 记录作废，
  照保存的挑法重新看一遍。保存配置那条路不动。
- 不加界面文字、不加 IPC 通道。日志：补进去或有没通的记 `external-client.claude-desktop.models.topped-up`（`added`、`rejected`、
  `overflow`），开着跳过记 `…top-up-skipped`，出错记 `…top-up-failed`。`editOwnedGateway` 算出来一个字不用改时不再写文件、不留备份。

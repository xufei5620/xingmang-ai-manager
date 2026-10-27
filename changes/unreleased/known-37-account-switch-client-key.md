## 用户

- 切换账号时勾了「同步到工具」，借 Claude Code、Codex 密钥的 Claude Desktop、WorkBuddy、OpenCode 也跟着换成新账号的密钥，
  不再留着上一个账号的。

## 开发

- 已知37：同一个站换账号、在「同步到工具」里勾上 Claude Code、Codex 以后，借它们那把的 Claude Desktop、WorkBuddy、
  OpenCode 跟着换成新账号的密钥。以前 #1113 只认当前账号名下的归属，换了账号以后客户端还拿着上一个账号的 Key，
  照样扣上一个账号的余额，首页却说它用的是别处的配置。
- 认法（`external-client-route-service.ts` 的 `externalClientKeyChange`）：首页认它不是当前账号那份；它那把是这个站
  别的账号缓存里给某个工具的托管 Key（`managed-cli-key-store.ts` 新加的 `readOtherAccounts`，`main.ts` 经
  `readOtherManagedCliKeyAccounts` 交给系统服务）；归属记在那个账号名下、来源不是 `manual`；那个工具现在用的就是
  当前账号缓存里那把（换账号时勾了它）。没勾的工具，借它密钥的客户端也不动。只换 Key，规矩同 #1113（型号要还在、
  开着等它退出、星芒关了下次开机补）。先把归属记到新账号名下再改客户端，中途断了下次检测照样认上一个账号那份。
- 换到另一个站（星芒账号和历史账号互切）不跟：客户端地址还在原来那个站，要换地址和 Key 两样，没做。
- 保存配置后台那一眼（`followManagedKeysNow`，取代 `config-save-service.ts` 原来的 `managedKeyFollowTarget` 加
  `scanExternalClients`）换成了会叫界面重读（`onToolRouteFollowed`）：换账号时首页在同步工具之前就读过客户端，
  不叫的话要等下次检测才显示已换好。#1113 撤销、重签那条路也一起受益。
- 只看缓存就能定的先定：这台电脑上没换过托管 Key、也没有别的账号时，跟以前一样一个工具配置都不读。
- 「切换账号」框「同步到工具」下那句跟着改准：以前说三家客户端「不会跟着换」，现在说借工具密钥的勾上那个工具就跟着换、
  星芒账号和历史账号互切时不换、自己填的不换（`SavedAccounts.tsx` 的 `accountSwitchDesktopClientsHint`）。

## 开发

- Claude Desktop 跟着 Claude Code 换 Key（#1113 第 1、2、4 条）：星芒替 Claude Code 换了 Key（个人中心撤销后换新、
  失效重签、换组，包括历史账号买了订阅换进订阅分组）以后，Claude Desktop 那份只换 Key，地址、型号和别的设置都不动
  （`claude-desktop-config.ts` 的 `followKey`，和 `followRoute` 共用 `editOwnedGateway` 那一笔写）。
  `system-service.ts`：Claude Code 以账号来源保存、Key 变了，马上看一眼（`saveConfig` 末尾）；平时的客户端检测也看
  （`followExternalClientRoutes`，换线路之后），所以星芒中途关了、下次开机照样补上。
- 全都对上才换：Claude Code 现在用的就是托管 Key 缓存里眼下那把；Claude Desktop 正在用的是星芒那份；它那把是缓存
  记着「被换掉」的 Claude Code 旧 Key（#1158 的 `replacedKeyDigests`）；归属是当前账号、地址是这个站的线路；
  不是客户自己填的；新 Key 认它写着的型号（没写型号的不查）。
- `external-client-ownership.ts` 的归属记录多记来源 `source`（`configured` / `account` / `manual`，配置弹窗选的那种）。
  客户自己填的（`manual`）不跟；0.2.20 以前保存的没记来源，凭「就是 Claude Code 换下来的那把」认。换线路、换 Key
  改写归属时照旧记着原来的来源（`rewrite`）。换 Key 先 `stageKey` 记下新那把再改客户端，改完才挪成正式那一把，
  中间断了两把都认，不会让客户端换上了新 Key、首页却不认它。
- Claude Desktop 开着就先不写，等它退出再换：沿用换线路 C11 那套每 5 分钟看一眼、回到星芒窗口时看一眼，两个站都等；
  这次界面上不加字，卡上提示下一个 PR 加。
- `main.ts` 把当前账号的托管 Key 缓存交给系统服务（`readCurrentManagedCliKeys`），明文只在主进程里用（I3）。
- 没做：WorkBuddy、OpenCode 借别的工具的 Key 时还不跟着换，下一个 PR 做。

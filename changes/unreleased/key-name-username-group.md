## 开发

- xm 站上星芒新签的密钥改叫「用户名-分组」（如 `yoyo-Claude-MAX`、`yoyo-GPT`，画图技能的 `yoyo-图片模型`），AI 对话新签的叫「用户名-分组-对话」（如 `yoyo-GPT-对话`），站长在后台令牌和日志里一眼看出是谁、哪个分组的（yoyo 10-16，对话加后缀也是他选的）。只管以后新建的：已经签好的不改名，复用分组里现成的那把时名字照旧；历史账号那套后端（Sub2API）不变。
- 起名在 `catalog.ts` 的 `buildAccountKeyName`：new-api 按 UTF-8 字节数限令牌名 50（rc.44 `controller/token.go` 的 `len(token.Name) > 50`），用户名最长 20 个字、可以是中文，所以按字节截，先截用户名、分组和后缀尽量留全，不会把一个字截成两半；用户名或分组是空的就照旧用调用方给的名字。
- `new-api-client.ts` 的 `provisionCliKey` 在建 Key 时换成新名字，AI 对话（`chat-credential-coordinator.ts`）传 `purpose: 'chat'` 接上「-对话」。命令行工具传的名字（`xingmang-desktop-*`）仍是这把 Key 以前的名字：`hasExhaustedCappedCliKey` 改成接收一组名字，两个名字下用完的额度上限都照样拦住；「比用完的上限更新的同名 Key = 用户自己放开了」只认以前的名字。AI 对话照旧不在这里按名字拦（它自己那把的上限由 `chat-credential-coordinator.ts` 认），两边额度互不牵连。`ipc.ts` 里按名字认是哪个工具（换新时照抄原来的上限）的那一步不受影响。
- 「每个工具的额度上限」「各工具累计用量」（`account-key-quota.ts`）多认「用户名-分组」那几把，用户名由页面从当前登录态传进来；配置框「自动准备」那一行显示的密钥名（`account-key-options.ts`）跟着换成新名字。

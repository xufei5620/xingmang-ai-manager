## 用户

- 星芒替 Claude Code、Codex 等工具换了密钥以后（在个人中心撤销、密钥失效重新签、换分组），借它们密钥的 Claude Desktop、WorkBuddy、OpenCode 也跟着换上新的，不用重新连接。客户端开着时，首页那一行写「还开着，完全退出后会自动换上新密钥」。

## 开发

- #1113 收尾：跟着换 Key 从 Claude Desktop 推广到 WorkBuddy、OpenCode，借的是哪个工具的都跟（`system-service.ts` 的
  `managedKeyFollowTarget` 交出所有换过 Key、自己也换上了缓存里那把的工具，`followExternalClientKey` 按「客户端那把是谁换下来的」
  对上）。WorkBuddy、OpenCode 那一笔写是 `external-tool-config.ts` 的 `followExternalToolKey`，和换线路共用 OpenCode 那段
  「改最后定义它的那个文件」（`openCodeFieldPlans`）。
- 客户端开着、等它退出再换 Key 的那一行带 `keyPending`（`external-client-contract.ts`），首页显示
  「还开着，完全退出后会自动换上新密钥」；跟换线路那句一样不落盘（`external-client-snapshot-cache.ts`）。
- `saveConfig` 末尾的「马上看一次」从只看 Claude Code 改成任何工具以账号来源保存、Key 变了都看。

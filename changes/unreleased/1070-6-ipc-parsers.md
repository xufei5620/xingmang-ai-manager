## 开发

- 拆 `ipc.ts` 的入参解析（#1070 第 6 步）：57 个 `parse*` 函数和它们共用的 `requiredString` 等基础校验按域搬进 `electron/ipc/parsers/` 下 11 个文件（`common`、`system`、`settings`、`extensions`、`tools`、`sessions`、`account`、`account-billing`、`account-usage`、`account-keys`、`ai-chat`），`ipc.ts` 从 3975 行降到约 2950 行，只留注册。函数体逐字没动（脚本逐块比对过），只多了 `export`，两处注释里的「above」改成写明在哪个文件；通道注册按域拆是第 7 步，这次没碰，`ipc-channel-policy.ts` 也没碰。
- `ipc.ts` 自己那份 `isRecord` 顺手换成 `input-guards.ts` 的（#1071 第 3 条说拆分时换）：旧写法 `Boolean(value && typeof value === 'object' && …)` 和新写法 `typeof value === 'object' && value !== null && …` 对任何输入结果都一样（对象都是真值）。`isPromiseLike` 两份判法不同，留在 `ipc.ts` 没换。
- 测试：`ipc.test.ts` 经处理器走的解析用例照旧全过，只改了 import；`ipc/parsers/` 下新加 6 个测试文件，直接钉路径、密钥、网址、命令相关的几个解析（会话 ID 和续接记录 ID 挡路径穿越、CLI 版本挡 npm 参数、MCP 命令和地址挡 NUL、对话图片只认素材 ID、删改密钥的 ID 只认正整数、Codex 中文界面开关写错就拒、线路只认登记过的）。

## 开发

- 连接 Claude Desktop 的弹窗不再默认借 Codex 的密钥、填 GPT 型号（0.2.19 测试包里默认成了 gpt-6.1-sol）。
  默认选择收进 `features/tools/external-client-defaults.ts`：访问密钥下拉把客户端自己那一家工具的密钥排第一
  （Claude Desktop 先列 Claude Code）；Claude Code 没配当前账号时，先找账号里分组名带 Claude 的那把，再轮到
  Codex、Grok；借别的工具的密钥时，只把合这个客户端的型号带过来（Claude Desktop 只认名字带 claude 的）；检测
  完原来填着的型号不是 Claude 的，Claude Desktop 改挑列表里的 Claude 型号，一个都没有就不替他保存；在下拉里切回
  自家工具那把密钥时，型号也回到打开时填的那个。WorkBuddy、OpenCode 的默认不变。

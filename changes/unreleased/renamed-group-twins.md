## 用户

- 账号里的分组改了名字（比如「GPT-中转/订阅」改叫「GPT」）。打开星芒时，还在用老名字下密钥的 Claude Code、Codex、Grok CLI 会自动换到新名字下的同名密钥，用起来没有区别，不用你点。
- 工具配置里「访问密钥」的下拉不再把同名的密钥新老名字下各列一遍，也不再列已经不支持的 Gemini CLI 的密钥。「个人中心」的「密钥」里照旧全部列出。

## 开发

- 站上改分组本名后，0.2.10～0.2.18 会在老名字下再建一套同名 Key（0.2.19 真机看到同名两把）。`account-cli-provisioner.ts` 新增 `moveKeysOffRenamedGroups`：本机缓存的分组在对照里排在后面时，读一次密钥列表——服务端已迁走的只改本机记的分组名；还在老名字下的，换到新名字下同名、能用的那把（只认同名、不新建；原来那把有额度上限或到期时间的不换），记进 `regrouped` 由开机那一轮重写星芒自己写的配置；读不到就照旧。
- `managed-cli-groups.ts` 加 `isRenamedAwayGroup`、`renamedAccountGroups`、`loadManagedCliGroupState`；`account:get-key-options` 多回 `renamedGroups`（老名字 → 新名字），配置框密钥下拉（`key-selection.ts` 的 `listedAccountKeys`）据此不列老名字下同名的那把，也不列下线工具星芒签的 Key；本机记的还是老名字的那把也认得出名字，不再写「名称未确认」。

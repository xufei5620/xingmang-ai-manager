## 用户

- 账号里的分组都换成了新名字（比如「GPT-中转/订阅」现在叫「GPT」），星芒也跟着只认新名字。已经配好的 Claude Code、Codex、Grok CLI 照常能用，不会重新配置；AI 对话里以前选过老名字的对话，打开就换到新名字接着聊。
- 工具配置里「访问密钥」的下拉，同一个分组里星芒签的同名密钥只列一把，也不再列已经不支持的 Gemini CLI 的密钥。「个人中心」的「密钥」里照旧全部列出。

## 开发

- xm 站 2026-10-16 删了老分组名（删前服务端把老名字下的 Key 全挂到了新名字下，Key 本身不变）。`catalog.ts` 的 `managedCliKeyProfiles` 换成新名字（Claude-MAX / GPT / Grok / Gemini），新增 `retiredAccountGroups`（老名字 → 新名字）与 `currentAccountGroupName`。
- `managed-cli-key-store.ts`：星芒账号的缓存读出来时把老名字换成新名字，开机不会因为「分组对不上」重签一把、再重写配置；0.2.12 以前写的不分站点的老缓存，分组是老出厂名的也照样认，不再整份当损坏挪走。
- `chat-key-store.ts`：AI 对话/画图的聊天密钥缓存同样把老名字换成新名字读出来（同一账号新老名字各一把时留较新的），老对话换到新名字后接着用原来那把，不会因为缓存对不上去拿分组里别的 Key 顶上、绕过那把聊天密钥自己设的上限。
- 配置框密钥下拉（`key-selection.ts` 的 `listedAccountKeys`）：`xingmang-` 开头的密钥同组同名只列一把（正选着的 > 最近用过的 > 编号大的），不列下线工具星芒签的 Key，也不列分组还写着老名字的（那种一调用就 403）。
- 旧回滚界面（已冻结）的 AI 对话默认分组取自 `managedCliKeyProfiles.codex.group`，跟着变成「GPT」；只改了它的测试断言，源码没动。
- AI 对话默认分组 `DEFAULT_CHAT_GROUP` 改「GPT」，聊天记录读出来时老名字换成新名字；画图技能的出厂图片分组 `IMAGE_SKILL_GROUP_NAMES` 改成「图片模型」「生图分组」，技能说明里的分组名跟着换；画布主进程执行器的兜底图片分组改「图片模型」。

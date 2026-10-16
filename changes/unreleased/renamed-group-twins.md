## 开发

- xm 站 2026-10-16 删了老分组名（删前服务端把老名字下的 Key 全挂到了新名字下，Key 本身不变）。`catalog.ts` 的 `managedCliKeyProfiles` 换成新名字（Claude-MAX / GPT / Grok / Gemini），新增 `retiredAccountGroups`（老名字 → 新名字）与 `currentAccountGroupName`。
- `managed-cli-key-store.ts`：星芒账号的缓存读出来时把老名字换成新名字，开机不会因为「分组对不上」重签一把、再重写配置；0.2.12 以前写的不分站点的老缓存，分组是老出厂名的也照样认，不再整份当损坏挪走。
- 配置框密钥下拉（`key-selection.ts` 的 `listedAccountKeys`）：`xingmang-` 开头的密钥同组同名只列一把（正选着的 > 最近用过的 > 编号大的），不列下线工具星芒签的 Key。
- AI 对话默认分组 `DEFAULT_CHAT_GROUP` 改「GPT」，聊天记录读出来时老名字换成新名字；画图技能的出厂图片分组 `IMAGE_SKILL_GROUP_NAMES` 改成「图片模型」「生图分组」，技能说明里的分组名跟着换；画布主进程执行器的兜底图片分组改「图片模型」。

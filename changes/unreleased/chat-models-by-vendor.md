## 用户

- 聊天不用再选分组了：模型菜单按厂商（OpenAI、Claude、Gemini、Grok 等）列出账号所有分组里能用的模型，
  选哪个就直接用哪个，每个模型下面的小字写着按哪个分组计费。菜单底部「刷新分组和模型」改叫「刷新模型」。

## 开发

- 聊天模型菜单去掉「分组」一节（产品负责人 2026-10-25 定、回「聊天改」批了字）：`useChatController.ts` 打开聊天时
  `prepareAllGroups` 把每个分组都准备一遍（一次三个，没对话密钥的分组这时签一把，之后复用），`state.ts` 新增
  `buildChatCatalog` / `chatModelVendor` / `pickChatGroup` / `settleChatModel` / `recommendedChatGroup`，去掉只剩测试在用的
  `resolveChatGroup`。同一模型几个分组都有时：对话正在用的分组 → 出图挑图片分组、聊天挑推荐分组 → 倍率低的 → 后台先后。
- 后台刷新（切回窗口、打开菜单）照旧只重读分组列表，读过的分组不再准备；新冒出来的分组读一次（这时给它签对话密钥）。
  模型哪个分组都没有了，后台刷新不悄悄换（`keepMissing`），留着「当前模型已不可用，请换一个模型」让用户自己换。主进程没改。

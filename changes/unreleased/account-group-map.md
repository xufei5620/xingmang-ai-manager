## 开发

- 服务状态文件新增 `accountGroups`（分组对照）：xm 站改分组本名时，发布者在 service-status 工作流的「分组对照」里写
  「codex=新名字|老名字」这类对照，客户端不用发版就跟过去。new-api 的分组没有编号、全按名字认，站上同一家又有好几个
  分组，靠名字里的词认不出改了名的那个（`electron/managed-cli-groups.ts` 新增 `mapped` 一档，排在写死名字之前；
  只在服务端给出的可用分组里挑，只管星芒账号）。
- 画图技能给 Codex 签 Key 不再写死 `GPT-中转/订阅`，和命令行工具同一套认法；画图分组先看对照
  （`electron/xingmang-ai-skill.ts`）。AI 对话没选过分组时跟主进程标的 `recommended` 走（`chat:list-groups`，
  `AiChatGroupSummary.recommended` 可选字段），不再在写死名字找不到时掉进排第一、没接渠道的 `default`。
- 对照读不到一律照旧认，不多等：签 Key 只搭启动时那一次读状态文件的便车（`ServiceStatusMonitor.settled()`）。
  0.2.18 及更早的客户端不认对照，改名过渡期服务端仍要保留老名字，见 `docs/SERVICE-STATUS.md`「分组对照」。

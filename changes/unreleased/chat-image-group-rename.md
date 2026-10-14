## 开发

- AI 对话和画布的图片分组模型精选也认 xm 站改名后的「图片模型」：`selectAiChatModelsForGroup` 以前只认
  `图片模型-中转/订阅`、`生图分组`，新名字认不出就把分组里全部模型都列出来（功能照常，只是没筛）。现在写死名单
  补上新名字，老名字照旧认；另外服务状态文件分组对照里「画图」那一项列的名字也算图片分组
  （`chat-credential-coordinator.ts` 新增可选 `loadAccountGroupHints`，和 `chat:list-groups` 共用 `main.ts` 里
  同一个读对照的函数），以后站上再改图片分组的本名，改对照就跟得上。只管星芒账号，读不到对照照旧只认写死名单。

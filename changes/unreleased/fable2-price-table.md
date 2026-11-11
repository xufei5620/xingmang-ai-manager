## 用户

- 个人中心「用量账单」多了「价格表」：用之前就能看到每个模型在各分组的价（每百万 Token 多少美元，已经算上分组倍数）。

## 开发

- Fable 第二轮 Q3 价格表那一半：新通道 `account:get-price-list`（契约、preload、注册、`ipc-channel-policy.ts`
  四处一起加，成功不记日志），主进程读画布「预计约 $x」同一份 `/api/pricing`，`parseModelPricing` 多留
  `model_ratio`、`completion_ratio`、`enable_groups`，`account-price-list.ts` 换成每个模型在各分组的价：
  按 token 计的 `model_ratio × 2 × 分组倍率` 美元每百万（同 `usage-pricing-parser.ts`），输出再乘
  `completion_ratio`；按次的写每次多少；分档计价的只标出来。能力表加 `supportsPriceList`（只有星芒账号），
  历史账号不出这一段。渲染层「调用明细 | 生成任务」切换多一段「价格表」，头一回切过去才读，读不到给「重试」，
  顶部搜索「价格」「哪个贵」落到这一段。模型菜单里的一句话说明要服务端先在价目里填 `description`，没做。

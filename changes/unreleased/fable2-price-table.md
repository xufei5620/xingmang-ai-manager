## 用户

- 个人中心多了两样：「用量账单」的「价格表」，用之前就能看到每个模型在各分组的价（每百万 Token 多少美元，
  已经算上分组倍数）；「充值订阅 › 我的订单」的「开发票」，在星芒里开一个开票窗口，用这个账号的用户名
  （历史账号用邮箱）和密码登录后，按已到账的订单申请、下载发票。

## 开发

- Fable 第二轮 Q3 价格表那一半：新通道 `account:get-price-list`（契约、preload、注册、`ipc-channel-policy.ts`
  四处一起加，成功不记日志），主进程读画布「预计约 $x」同一份 `/api/pricing`，`parseModelPricing` 多留
  `model_ratio`、`completion_ratio`、`enable_groups`，`account-price-list.ts` 换成每个模型在各分组的价：
  按 token 计的 `model_ratio × 2 × 分组倍率` 美元每百万（同 `usage-pricing-parser.ts`），输出再乘
  `completion_ratio`；按次的写每次多少；分档计价的只标出来。能力表加 `supportsPriceList`（只有星芒账号），
  历史账号不出这一段。渲染层「调用明细 | 生成任务」切换多一段「价格表」，头一回切过去才读，读不到给「重试」，
  顶部搜索「价格」「哪个贵」落到这一段。模型菜单里的一句话说明要服务端先在价目里填 `description`，没做。

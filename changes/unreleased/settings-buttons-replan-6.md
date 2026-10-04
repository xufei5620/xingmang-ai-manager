## 用户

- 个人中心：九个页签挪到左边，分「账号与充值」「用量」「密钥与设备」三组；页头写「当前账号：用户名（邮箱）」，右边「切换账号」「刷新」。
  刷新只留页头这一颗，点了重读账号资料、余额和正在看的这一页。顶部搜索「切换账号」直接落到这颗按钮上。
- 个人中心：资料或余额暂时读不到时，左边页签照常在，充值、订单、登录设备照常能进；读不到的那一页写「当前账号的资料暂时没有读到」，
  给「重新加载」「联系客服」。订单、异步任务、调用明细、登录设备读不到时也各写一句「…暂时没有读到」并给「重新加载」，不再写成「还没有订单」。
- 我的账号：头像小一号，用户名和邮箱改成只读文字，新加「密码」一行放「修改密码」，显示名称改过才能点「保存」；「退出当前账号」改叫「退出登录」。
  已保存的账号只有自己时只剩一句说明和「添加另一个账号」，「同步到工具」默认收起。
- 用量看板：「按工具分账」改叫「各工具累计用量」，挪到页面最下面，并写明不受上面时间范围影响；点页头「刷新」算到刚刚这一刻，不再停在第一次打开这一页的时候。密钥页「每个工具的额度上限」只列已经有密钥的工具。
- 调用明细、异步任务：筛选框收起来，第一行只放时间、模型（异步任务是状态）和「查询」，其余的点「展开筛选」才出现；每页条数挪到表格下面翻页那里。
- 充值与订阅：订阅读不到不再挡充值；没有支付渠道时提示放在充值卡最上面，并说可以在右边用充值码兑换；档位卡不再写「正在计算」「无赠送」；「兑换」挪到输入框右边。
  订阅开通后工具没换过去时多一颗「去检查页」。
- 邀请返利：邀请链接放在最上面，四个数字排成一行，「转入余额」放进「可转余额」那一格。登录设备：别的设备的「退出登录」改叫「让它下线」，「退出其他设备」改叫「下线其他设备」。

## 开发

- 按钮与设置重新规划第 6 个 PR（第五部分第 56～71 条，第六部分第 9、10、11 条照「不点头」）。`registry/business.ts` 的 `accountTabs` 次序改成左边子导航从上到下的次序，
  新加 `accountTabGroups`（三组，registry 测试钉着每页只在一组里出现一次）、`accountSwitchAnchor` / `accountSwitchKeywords`；
  `command-search.ts` 的个人中心组多一条「切换账号」，`App.tsx` 的 `navigate('account', accountSwitchAnchor)` 走 `requestRowFocus('account', …)`，不换分页。
- `pages-account.tsx`：账号状态、资料和余额拆成两个 `useResource`，`accountTabNeeds(tab)` 决定每页等哪一样；页头副标题 `accountHeadLead(profile)`；
  子导航 `AccountNav` 手动激活（方向键只挪焦点，回车/空格打开）。页头「刷新」经 `refreshRequest` 递给当时停着的那一页，各页用 `useRefreshRequest`（`business-common.tsx`）接；
  列表读不到统一用 `ListReadFailure`，原因那一段 `FailureReason` 和 `ResultNotice` 共用；读取中的占位条是 `PlaceholderBar`。资料、余额再读没读到时留着上次读到的那份（按账号认，换账号不沿用；先发后到的旧结果不算），
  要它的那页顶上出 `ResultNotice` 带「重新加载」；用量看板每次读都把时间范围算到当下；「我的账号」卡的登录设备台数只在刷新和「登录设备」页让设备下线后重读（`devicesChanged`）。
- 充值页把充值信息和订阅（可选订阅 + 我的订阅）拆成两次读取，再读没读到时照列表的规矩说读不到，不留着旧的；`describeTopupTier` 的 `quote` 多一个 `'unavailable'`，返回 `quoting` / `bonus`，去掉 `hasBonus`。
  `subscriptionToolsNotice` 出错时带 `action: 'health'`。`AccountFilters` 加 `primary`（第一行放哪几个框），`hiddenFilterCount` 只数收起的框里生效的条件。
  `ToolKeyLimits` 的行和「还没配」那一行由 `toolKeyLimitLayout` 算；`LocalAvatar` 加 56 号。
- 测试：`e2e/v2-business-fixture.tsx` 加 `fail=profile|tasks|orders|topup|devices`、`noPayment`、`otherDevice`、`help`；`e2e/v2-business.test.mjs` 补 15 条个人中心用例（fixture 多一个 `failNextRead` 让下一次资料或订阅读取失败、`profileReadHarness` 让下一次资料读取晚回来，并接上 `updateAccountDisplayName`），
  `keyboard.browser-check.mjs` 补顶部搜索「切换账号」落点，`app-check.mjs` 跟着「退出登录」和页头「刷新」改。

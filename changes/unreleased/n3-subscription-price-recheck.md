## 用户

- 买订阅的框开着时套餐改了价，框里会换成新价并提醒你，再点一次才会下单。

## 开发

- 0.2.25 总单第 21 项（11-18 复核 N3）：个人中心「充值订阅」点「购买」，框里摆的是打开那一刻的套餐，之后套餐列表在后台重读
  （窗口回到前台、付款结果回来）框里也不跟着换；点付款时直接拿套餐编号下单。服务端两边都只认编号、照当时的价扣
  （new-api `SubscriptionRequestBalancePay` → `model.PurchaseSubscriptionWithBalance(userId, planId)`；历史账号的在线下单只带
  `plan_id`），余额买又是直接扣、后面没有支付页再让客户看一眼，所以框开着时后台改了价，客户看到 ¥29、扣的是 ¥39。
- `features/account/recharge.ts` 新增三个纯函数：`followPurchasePlan` 按编号拿后台现在那份跟框里的比，分成没变 / 价格或币种变了 /
  价格没变但时长、额度、额度重置规矩变了 / 下架了四种；`purchasePlanNotice` 给出框顶那条的字；`purchaseMethodFor` 是原来
  `openPurchase` 里挑默认支付方式的那一句，加了「框开着时套餐换了，客户选好的还能用就不动」。
- `AccountRecharge.tsx`：点付款先再读一遍套餐列表（`getAccountSubscriptionPlans`），对不上就不下单，框里换成新那份、框顶摆一条提醒，
  客户再点一次才下单；下架了付款按钮灰着，框开着时又上架了就收起那条。套餐列表在后台重读回来时框里同样跟着换。读套餐列表失败就不下单，报读的那个错。
  只动渲染层，主进程、IPC、`sub2api-relay-backend.ts`、服务端都没动。
- 新字（等 yoyo 回「改」）：「价格刚调整过」「刚才是 ¥29，现在是 ¥39。下面写的是现在的价格，没问题再点一次。」
  「套餐内容刚调整过」「价格没变，时长或额度改了。下面写的是现在的内容，没问题再点一次。」「这个套餐刚下架了」「关掉这个框，看看别的套餐。」
- 用例：`recharge.test.ts` 钉住比对、提醒的字和支付方式怎么挑；`e2e/v2-business.test.mjs` 三条浏览器用例（点付款时发现涨价、
  框开着时窗口回到前台重读、下架了又上架），在旧代码上全红。`e2e/v2-business-fixture.tsx` 加了 `subscriptionPlanHarness`
  模拟后台改价、下架、又上架，`planBalancePay` 让那个套餐能用余额买。

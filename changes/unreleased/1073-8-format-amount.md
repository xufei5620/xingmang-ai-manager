## 开发

- 新界面充值页里逐字相同的两份 `formatAmount`（`features/account/recharge.ts`、`topup-tier.ts`）收成
  `topup-tier.ts` 一份，套餐价、订单标题、档位到账金额照旧共用这一种写法（整数不带小数，其余两位小数，
  不加千分位）；改之前先用测试把三处在旧代码上的输出逐字钉住，显示一个字没变（#1073 第 8 条）。

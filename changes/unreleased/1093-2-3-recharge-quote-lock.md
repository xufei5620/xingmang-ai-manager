## 用户

- 充值页点「充值」后、还在确认价格的那一会儿，档位、金额和支付方式先锁住，确认框和付款金额一定是最后选的那一档；充值码、买套餐、确认报价几个弹窗打开时也不再带着上一个弹窗的报错。

## 开发

- #1093 第 2 条：`features/account/AccountRecharge.tsx` 算价期间（`operation.busy === 'quote'`）把档位、金额、支付方式那个 fieldset 禁用；
  报价另加请求编号 `quoteRequest`，换档位、金额、渠道都加一，问价途中金额被换掉（停在充值页时从首页活动卡片又点了一档，不经过 fieldset）
  回来的那次报价丢掉，不弹确认框。以前回来就 `setQuote`，确认框和 `createAccountTopupPayment` 都照旧金额走。
- #1093 第 3 条：三个弹窗共用一个 `useOperation`，`openRedeem` / `openPurchase` 打开时先 `operation.clear()`；弹窗里的 `ResultNotice`
  只摆自己那个动作（`payment` / `redeem` / `subscribe`）的失败，先点的算价、存扣费顺序赶在弹窗开着时失败只上页头那条。
- `e2e/v2-business-fixture.tsx` 加 `topupQuoteHarness`（挂住下一次试算）、`pickRechargeTier`（模拟活动卡片点档）、`fail=redeem`。

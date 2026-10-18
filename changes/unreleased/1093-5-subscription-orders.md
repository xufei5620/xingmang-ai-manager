## 用户

- 星芒账号在「我的订单」里，付过款的订阅单写成「开通订阅」，不再显示成「充值 $0」；按单号搜一笔还没付成的订阅，会说明订阅订单付款成功后才出现，不再叫你核对单号。买订阅时关掉支付窗口，提示改说「订阅会自动开通」，不再说更新余额。

## 开发

- #1093 第 5 条坐实不成立：对 new-api rc.24、rc.40、rc.44、rc.45 和 main 源码核过，订阅单付成时 `CompleteSubscriptionOrder` 会往 `top_ups` 补一行同单号的成功记录（`amount` 记 0），客户端现有的按单号查充值表就能确认到账；没有给用户查订阅订单的接口，付成之前和过期的订阅单查不到。事实记进 `docs/RECON-new-api.md` C 节第 11 条，`electron/payment-status-reader.test.ts` 钉住这条路。
- 由此带出的界面问题在 `src/renderer-v2/features/account/recharge.ts` 修：按上游订阅单号前缀（`SUBUSR`、`sub_ref_`、`WAFFO_PANCAKE_SUB-`）认出星芒账号的订阅单，订单行标题、按单号搜不到时的空状态、订阅关窗后的两句提示各改一处。历史账号不按这个认。

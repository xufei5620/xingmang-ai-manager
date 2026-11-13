## 开发

- 余额审查 F8-1（`0.2.24-深查/查余额和扣费显示.md`）：星芒账号的邀请返利可以只转一部分，但「转入余额」确认框标题
  以前总写全部可转的数（可转 $10、填了 $3，标题还是「把 $10.00 返利转入余额？」）。现在标题写这次要转的数
  （「把 $3.00 返利转入余额？」），句式没变，yoyo 2026-11-13 回「改」。换算放在 `account-center.ts` 的
  `affiliateTransferTitleQuota`，取整跟发给后台的 `affiliateTransferQuota` 同一种，标题、发出去的额度、转完的提示是同一个数；
  框里还不是正数（清空、填 0）时照旧写全部可转的数。历史账号只能全转，标题照旧是全额。
- 动手前对过两边后台源码：new-api（rc.24、rc.40、rc.45、rc.51 与 main）`POST /api/user/aff_transfer` 收整数 `quota`，
  按这个数原样从 `aff_quota` 扣、加进 `quota`，不够就拒，部分转入是真的；上游自己的转入框也是 `Math.round(美元 × quota_per_unit)`。
  Sub2API（270eac6 与 main）`POST /api/v1/user/aff/transfer` 不收金额，每次把可转返利（`DECIMAL(20,8)`，按美元记）一次全转。
  更新说明「用户」一节已满 60 条，所以只写「开发」。

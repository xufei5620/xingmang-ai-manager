## 开发

- 历史账号的邀请返利不是整数美元就转不进余额（`0.2.24-深查/查余额和扣费显示.md` 余额 F4），不改字、不加通道：
  历史账号 1 个单位 = 1 美元，返利按比例算出来常带小数，后台又只收和可转返利一分不差的全额；以前界面把金额
  `Math.round` 成整数、主进程入参只收正整数，$3.50 被说「不能超过可用返利」，$3.456 被后台拒「只能一次性全部转入」。
- `pages-account.tsx` 邀请返利：历史账号的金额框改成只读、显示的就是这次要转的全额，发出去的是 `profile.affQuota` 原值；
  换算挪进 `account-center.ts` 的 `affiliateTransferQuota`。星芒账号照旧可以只转一部分、按整数额度发。
- `account:transfer-affiliate-quota` 的入参 `parseAccountAffiliateTransferInput` 多一个 `sub2Api`（照密钥额度那条的写法，
  由 `getActiveSiteId() === 'solov-api'` 决定）：历史账号放开到「有限正数」，仍拒 NaN、Infinity、0、负数和非数字；星芒账号
  照旧只收正整数（`new-api-client.ts` 发请求前也还是只认整数）。这是放宽一处入参校验，yoyo 2026-11-13 亲手打字同意。
  `sub2api-relay-backend.ts` 没动。

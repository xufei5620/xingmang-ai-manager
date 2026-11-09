## 用户

- 个人中心的几处说法改得更清楚：「账户」统一叫「账号」；邀请返利从来没赚过时按钮写「还没有返利」，不再写「已全部转入」；转入金额写「美元」；
  撤销密钥后工具连不上时按钮叫「去配置」；编辑资料写明头像不超过 2 MB、名字显示在左下角；刚切换账号时的提示改成「账号刚切换过，请再试一次」。

## 开发

- 0.2.24 深查改字 Z04（W9c W10 W11b W11c W12a W18 W44 W76 W77 W78 W91）：`AccountOverview.tsx`、`AccountRecharge.tsx`、`pages-account.tsx`、
  `LocalAvatar.tsx`、`AccountProfileDialog.tsx` 换字；W44 按 `affHistoryQuota` 区分「赚过、转完了」和「从没赚过」。
  W91 那句是主进程报的（`realm-account.ts` STALE、`account-work-gate.ts`、`active-identity.ts`、`account-billing.ts`、`bootstrap/ai-services.ts`），
  六处和渲染层 `account-read-error.ts` 认这句的地方一起换，测试里写死的字跟着改。

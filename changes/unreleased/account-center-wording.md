## 开发

- 0.2.24 深查改字 Z04（W9c W10 W11b W11c W12a W18 W44 W76 W77 W78 W91）：`AccountOverview.tsx`、`AccountRecharge.tsx`、`pages-account.tsx`、
  `LocalAvatar.tsx`、`AccountProfileDialog.tsx` 换字；W44 按 `affHistoryQuota` 区分「赚过、转完了」和「从没赚过」（后者写「还没有返利」）。
  W91 那句是主进程报的（`realm-account.ts` STALE、`account-work-gate.ts`、`active-identity.ts`、`account-billing.ts`、`bootstrap/ai-services.ts`），
  六处和渲染层 `account-read-error.ts` 认这句的地方一起换，测试里写死的字跟着改。用户行按协调者口径最后统一补一条合并的。

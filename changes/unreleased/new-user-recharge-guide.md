## 用户

- 新手引导最后一步多了「还没充值的话先充值」一行和「去充值」按钮，点了直接进软件里的充值页；以后余额用完，点左下角余额旁边的「充值」就行。
- 新账号余额是 0 时，首页那行提示改成「当前账号余额是 $0，充值后 AI 工具才能用」，不再说「余额只剩 $0.00」。
- 走完引导后的功能导览第 3 步改成「余额和充值在这里」，指给你看左下角的「充值」。

## 开发

- `guide-result.ts` 多 `usesAccountBalance`（聊天已登录、或当前账号来源且已连好时为 true）；`StartGuide.tsx` 只在 ready 步且花的是当前账号余额时给「去充值」，点了先 `complete` 再走 `onFailureAction('recharge')`，免得下次登录引导又从头弹出。没动 App.tsx。
- `Home.tsx` 抽出 `lowBalanceText`，余额 ≤ 0 换说法；低余额提示加 `data-testid="home-low-balance"`，订阅相关测试改按 testid 断言。
- `registry/shell.ts` 导览第 3 步文案。

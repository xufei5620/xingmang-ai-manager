## 用户

- Codex 用 ChatGPT 官方账号登录时，首页卡片上又能直接看到套餐和多久后续期（比如「官方账号 · Plus · 4天后续期」），鼠标停上去能看到具体日期，不用再点开菜单找。

## 开发

- 新界面 `features/tools/model.ts` 加 `officialAccountSubtitle`，首页 Codex 两行在官方来源时把主进程已经读出的 `officialAccountPlan` / `officialAccountRenewsAt` 接在「官方账号」后面；续期日已过或读不到就不写。`ui/core.tsx` 的 `ToolRow` 加可选 `modelHint`，悬停时在整行文字下面补一行具体日期。v0.1.31 旧界面的「套餐 / 续期」标签在 #117 重做新界面时收进了「官方账户额度」弹窗，这次照设计稿 G05 放回卡片上，弹窗不动。

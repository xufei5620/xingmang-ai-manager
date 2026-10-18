## 用户

- 一个东西只用一个名字：界面上的「Key」都改叫「密钥」；教程和报错里指的位置改成「个人中心 → 密钥管理」；首页卡片上的按钮和错误框统一叫「重新写入密钥」；新手引导和切换账号时，登录后的来源都叫「当前账号」，自己填的叫「自己的密钥」；托盘里的「软件更新」改叫「版本更新」；网络连不上时首页的标题叫「网络连不上」，登录页不再叫你把星芒自己的加速关掉。
- 金额带上千分位（$23,456.78），首页、侧栏、状态栏和个人中心写法一致，读不到时都写「—」。
- 用量明细和调用详情的时间带上几点（9月12日 18:40），时间、Token、花费三列不再被挤成两行；日期统一写成「10月3日」，「我的订阅」和 ChatGPT 账号额度也是这个写法。
- 「花费突然变多」提醒的说明补上「且至少 $5」，跟实际的提醒条件一致。

## 开发

- #1102 第 1~7 条、#1104 第 9 条、#1133 第 1、2、5、6 条、#1073 第 8 条 a、b（红队改字 B 组「叫法统一」，yoyo 2026-10-18 批）。逐字清单见 PR 正文。
- 连带改的代码：`operation-error.ts` 的 `configWritingActions` 按动作名认「这次写的是配置文件」，动作名收成常量 `rewriteKeyAction`（「重新写入密钥」），App.tsx 三处共用；`account-switch-sync.ts` 的来源小字收成 `accountSyncAccountReason` / `accountSyncManualReason`，`SavedAccounts.tsx` 的默认勾选按常量认，改字不会让切换账号时的工具变灰。
- 金额格式化收进 `business-common.tsx`：`dollars()` 带千分位、读不到写「—」，新导出 `quotaMoney()` 取代 AccountUsage、AccountRecharge、pages-account 三份逐字相同的副本；首页 `money()`、App.tsx 侧栏和状态栏两处内联、`lowBalanceText`、订阅提醒、近 7 天柱子悬停都改走 `dollars()`。主进程系统通知「花费突然变多」和托盘的金额写法没动。
- 新增 `ClockTime`（`formatClockTime` 加鼠标提示），用量明细和调用详情改用它；`.v2-usage-nowrap` 让时间、Token、花费三列不折行。
- 日期统一成不带空格的「10月3日」：`shortDate`、`spendDayTitle`、`usage.ts` 的 `monthDay`、`weekSpendHint`、主进程 `subscriptionEndDate`；「我的订阅」到期和 ChatGPT 额度弹窗的续订、恢复时间改照 `shortDate` 写，更新时间改用 `formatClockTime`。
- 主进程只改了客户看得到的句子（connection-check 的 nextStep、额度用完、撤销失败、托盘），设置值、日志里的名字和别的约 125 处带「Key」的报错原话这次没动。

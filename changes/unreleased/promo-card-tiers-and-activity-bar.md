## 用户

- 首页充值活动卡片改成一档一格：每格写清「充多少 · 送几成 · 到账多少」，送得最多的一格有标记，点哪一格就进充值页并选好这一档。档位跟当前账号的充值优惠设置走，和充值页同一份数字；卡片上不再出现网站地址，正文也不再挤成一长串。
- 活动还没截止时，顶栏下面多一条淡红色的活动提醒，每个页面都看得到，写着活动名和截止日期，点一下直接去充值或看活动全文。点 × 只收起当天，活动一截止自动消失。
- 卡片上的「知道了」改名「这个活动不再提醒」，意思更清楚；标题带「邀请」的活动（比如邀请有礼）也算活动，收进卡片底部一行，不再单独占一条灰条。

## 开发

- `promo-announcements.ts`：`activePromos` 同时认「充值」「邀请」两类活动（`kind`），`activeRechargePromos` 只取充值类，大卡片和每日提醒仍只跟充值活动；新增 `buildPromoTiers`（复用 `features/account/topup-bonus.ts` 的 `buildTopupBonus`，由 `pages-account.tsx` 移出并原样再导出）、`promoPreviewLines`（没配优惠时正文前三行、保留换行）、`stripSiteAddresses`、`promoShortName`、`formatPromoShortDeadline`、活动条当天收起的本机记录。
- `Announcement.tsx`：`PromoCard` 按档位渲染，`PromoBar` 新组件；`AnnouncementCenter` 新增 `readTopupOffers`（活动期间最多十分钟读一次充值配置），`onTopUp` 可带金额。App 的 `navigate('account', 'recharge', amount)` 经 `BusinessPage` → `AccountPage` → `AccountRecharge` 预选金额。

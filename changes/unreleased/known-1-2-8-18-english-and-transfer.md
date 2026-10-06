## 用户

- 个人中心的订阅不在生效中时，状态改成中文（已到期、已撤销、已停用，认不出的写「待确认」），不再直接显示英文。
- 外接工具、技能、插件的详情里，「范围」一栏改成中文（「我的（全局）」「当前项目」这类），不再是英文。
- 邀请返利转出一部分以后再点「转入余额」，默认金额会变成现在还能转的数，不再停在转之前那个数。
- 游戏加速页大图左上角那行英文小字改成「游戏加速」。

## 开发

- 已知1：`pages-account.tsx` 订阅卡状态不是 active 时原样显示 `subscription.status`。新增 `registry/business.ts` 的
  `subscriptionStates` 和 `pages-account.tsx` 的 `subscriptionStateFor`：new-api 的 active / expired / cancelled、Sub2API 的
  active / expired / suspended / revoked（对过 new-api v1.0.0-rc.24 与 Sub2API 270eac6 的源码），加上界面规范里的 exhausted；
  cancelled、revoked 用 Key 状态现成的「已撤销」，suspended 用「已停用」，其余值用订单那边现成的「待确认」，查表走 `Object.hasOwn`。
- 已知2：`pages-management.tsx` 详情抽屉「范围」原样显示 scope。新增 `extensionScopeLabel`，按 `scopeOptions` 现成标签显示；
  Claude 的 local 显示「当前项目」，Gemini 扩展自带技能的 extension（装在用户目录）显示「我的（全局）」，没有 scope 照旧「未提供」。
- 已知8：`AccountInvite` 的转入金额只在挂上时算一次。转出一部分后资料重读、这张卡不重挂，再点开还是旧数（或上次手填的数），
  比剩下的多时照着确认会报「转入金额不能超过可用返利」。改成每次点开按当时的可转余额重算。
- 已知18：`AccelerationView.tsx` 的眉标 GAME CONNECT 换成现成的页面名「游戏加速」，`ui-spec/06-copy-guide.md` 第一段同步（原型没改）。
- 测试：`business.test.ts` 钉住两个映射（含 `constructor`、`__proto__` 这类原型链上的键）；`e2e/v2-business.test.mjs` 加订阅五种状态、
  转出一部分后再点开对话框两条；加速 `browser-check.mjs` 断言眉标。

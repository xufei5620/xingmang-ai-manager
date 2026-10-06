## 用户

- 技能、插件按「当前项目」「我的（全局）」筛选时，只在这个项目里用的 Claude 插件、Gemini 扩展自带的技能也会列出来，和详情里写的范围一致。

## 开发

- 已知2 跟进：`pages-management.tsx` 的「范围」筛选只比原样的 scope，详情写「当前项目」的 local 插件在「当前项目」下看不到，
  写「我的（全局）」的 Gemini 扩展自带技能（extension）在「我的（全局）」下也看不到，只有「全部范围」里有。新增 `extensionInScope`，
  和 `extensionScopeLabel` 共用 `extensionShownScope` 这一套归类；增删改照旧交回原样的 scope。
- ui-spec：加速页原型模块 `99z-acceleration.js` 的眉标改成「游戏加速」并重建原型 HTML，06 去掉「原型未同步」那半句；
  22 订阅一行补 cancelled / revoked / suspended 和兜底「待确认」；04 技能插件一节写明 local、extension 的归类；CHANGELOG 记一行受控。
- 测试：`business.test.ts` 钉住 `extensionInScope`；`e2e/v2-business.test.mjs` 加一条：筛「当前项目」「我的（全局）」时，
  local 插件和扩展自带技能出现在详情写的那一档（旧代码上红在等 local 插件那一行）。

## 开发

- 收紧四处会静默放行的 e2e 断言（T-G2、T-G3、T-G4、T-G11），不改被测代码：
- T-G2：`e2e/account-commerce-interactions.test.mjs` 的多视口视觉检查，账号导航按钮加数量下限
  （空集合不再让 `every` 恒真）、表格末列固定失配从三元 fallback `true` 改为判负并限定在两个表格分区、
  删掉按定义恒真且从未被断言的 `bodyHasScrollableContent`。
- T-G3：新增 `e2e/page-errors.mjs`，12 个浏览器套件统一记录 `pageerror` 并在收尾断言为空
  （`v2-business.test.mjs` 原本只 `console.error`，CI 日志里会被淹掉）；
  `scripts/ci-workflow-config.test.cjs` 加门禁，新套件漏挂即红。
- T-G4：`e2e/maintenance-layout.test.mjs` 不再断言抄进测试的一份 markup 副本，改为挂 `MaintenancePage`
  真实渲染出来的行（新增 `e2e/maintenance-layout-fixture.html` / `.tsx`），组件结构改动后这些断言才会真的红。
- T-G11：`e2e/primary-views-interactions.test.mjs` 的「减少动画」断言原先选择器
  （`.welcome-orbit,.welcome-node`）在页面上一个元素都匹配不到、恒真；改成从页面本身读出所有仍在播放的
  装饰动画。据此发现 legacy 欢迎页 `data-motion-paused` 没有对应样式规则、两圈星轨照转，
  legacy 已冻结故按现状钉住并注明，等修复后该断言会主动变红提醒收紧。
- `e2e/account-commerce-interactions.test.mjs` 的 21 处 `page.goto` 统一走本文件的 `visit()`，
  挂载等待复用 `e2e/fixture-readiness.mjs` 的 `fixtureReadyTimeoutMs`，治整跑 `npm test` 时的偶发 30 秒超时；
  用例自己的断言仍用默认超时。

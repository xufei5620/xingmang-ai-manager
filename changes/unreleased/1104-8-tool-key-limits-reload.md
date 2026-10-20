## 开发

- #1104 第 8 条：`ToolKeyLimits.tsx` 读密钥失败时给 `ResultNotice` 传 `retry`（「重新加载」，调 `resource.reload()`），
  照 `AccountOverview.tsx` 我的订阅、`pages-account.tsx` 资料读不到那两处现成写法，不新增字。保存上限失败那条不给，
  改的数还在格子里，再点「保存」就是重试。读到过「一个工具都没配」、页头刷新又没读到时不再收成那行灰字，照常出卡片，
  红条和「重新加载」才看得见。浏览器用例 `e2e/v2-business.test.mjs` 两种都走了一遍。

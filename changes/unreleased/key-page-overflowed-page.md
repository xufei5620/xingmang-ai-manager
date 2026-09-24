## 用户

- 密钥页在最后一页撤销掉最后一把密钥后，会自动回到上一页，不再停在一张空页上显示「2 / 1」。

## 开发

- #496（审计 D22）：`business-common.tsx` 新增纯函数 `overflowedPage`，`pages-account.tsx` 的密钥列表在总数变少、当前页越界时退到最后一页。`e2e/v2-business-fixture.tsx` 加 `keyCount=N` 真分页夹具（撤销会真的少一把），`e2e/v2-business.test.mjs` 钉住 21 → 20 的情形。

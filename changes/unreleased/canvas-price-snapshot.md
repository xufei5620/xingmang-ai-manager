## 开发

- 画布完善第 2b 条第 2 步（桌面那半）：画布宿主桥加一条只读通道 `canvas-host:get-price-snapshot`，不收任何参数，`capabilities().features.quote` 改成开。回答是 `{ models: { 型号: { usd, approximate? } }, groupRatios: { 分组: 倍率 }, readAt }`：星芒账号读这个账号的 `GET /api/pricing`（`new-api-client.ts` 的 `getModelPricing`，响应上限 4 MiB、最多 2000 个型号），只留按次计价、桌面认得的型号，视频标 `approximate`（站点可能按时长、尺寸再乘）；按 token、按表达式或插件计价的不给。历史账号没有按型号的价目，回 `null`，画布写「价格未知」。
- 读的节奏在 `canvas-price-snapshot.ts`：十分钟内只读一次、同时问只读一次，读失败一分钟内不再读（画布问得再勤也不打站点），读失败时照旧回上次读到的，读回来换了账号就不要。扣费照旧由主进程和站点算，这个数不拿去扣费。
- 画布上的「预计约 $x」随下一次内核同步进来，那时再写「用户」那条。

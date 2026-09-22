## 用户

- 断网或网络不通时打开软件，首页不再干等四个命令行工具的「最新版本」查询各自超时（十几秒），已装的版本立刻就出来，「最新版」那一格显示「当前可能没有网络，这次没有检查最新版本」；联网后下一次扫描或手动刷新会自己补上，其间也不会谎报「有新版本」。

## 开发

- `electron/system-service.ts`：`scanSystem` 的四家最新版探测拆出三个顶层纯函数——`networkProbeSuggestsOffline`（网络位置探测 `region` 为 `unknown` 且带 error 才算离线，拿到 IP/国家代码的不算）、`buildUncheckedLatestVersion`（占位结果：已装的 `failed` + 中文原因，没装的照旧 `skipped`）、`settleLatestVersionProbes`（给一批探测套总预算，`budgetMs` 为 `null` 时等齐 = 联网时的老行为）。
- 判定离线时总预算 `offlineLatestVersionBudgetMs = 3_000`，到点先返回快照；超时的那几个 Promise 留在后台自己走完并写进既有 `npmLatestCache`，不重发也不加定时器。探测 reject 时仍保留原始原因，与改动前一致。
- 不改 IPC 契约，不改渲染层：`buildCliStatus` 对 `failed` 探测本来就不置 `updateAvailable`，`features/tools/model.ts` 的 `updateCheckFailure` 会直接把这句中文显示在版本列。
- `electron/system-service.test.ts`：纯函数四例 + 两个 `scanSystem` 集成用例（离线：永不返回的 npm 探测，断言 3 秒预算内返回且四家都是 `failed` + 中文原因；联网：网络位置探测成功、npm 探测比预算慢，断言仍等到 `checked`）。

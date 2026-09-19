## 开发

- quality 工作流的 Windows 作业从一个串行作业拆成并行分片，把每个 PR 的墙钟等待从约 27 分钟压到 10 分钟以内。
  原先 `test:windows`（约 11 分钟）与 `test:v2`（约 9 分钟）在同一台 runner 上前后跑，其余五台闲着。
- 新的 `windows-test` 是一个 `fail-fast: false` 的矩阵：`test:vitest` 的两个 `--shard` 半区、`test:node`、
  `test:v2:vitest`、`test:v2:browser`；`windows-package` 单独承担 typecheck、compile、三个 Electron
  冒烟与打包加固检查（这些步骤各自带 `timeout-minutes`，且彼此有先后依赖，所以不进矩阵）。
- `package.json` 把两条组合脚本拆出可分片的半区：`test:vitest`、`test:v2:vitest`、`test:v2:browser:1`、
  `test:vitest:1`、`test:vitest:2`。`npm test`、`npm run test:windows`、`npm run test:v2`
  的行为与覆盖范围一字未改，本地照常用它们。没有跳过、禁用或重试任何用例，也没有调低任何超时。
- 新增一个只做汇总的 `test` 作业：把 Windows 各分片折回成一个同名检查，既让可能按名字要求 `test` 的分支保护继续
  成立，也让「被取消的矩阵」不会被读成通过（它自己判定改动范围，文档类改动时报成功而不是 skipped）。
  `quality-gate` 相应改为读 `test` 的结果。
- `windows-package` 不再装 Chromium：它的冒烟一律走 `_electron.launch`，用的是安装时落下的 Electron，不是下载的
  Chromium。`scripts/ci-workflow-config.test.cjs` 补了分片完备性门禁——vitest 半区必须逐个被矩阵派发，
  `test:v2:browser` 的两半合起来必须与整份文件清单逐文件相等且无重复，任何一半漏派发或漏文件都会红。
- 代价是 runner 并发槽位而不是分钟数：仓库是公开的，Actions 不计费；账号的并发作业上限由所有 open PR 共享，
  同时挂着二十多条 PR 时分片会排队而不是失败。排队不算执行时间，`timeout-minutes` 计的是执行时长，所以各作业
  的超时上限不需要因排队而调大。
- `test:v2:browser` 有意整份派发，不再往下拆：它的每个文件都用同一套 `configFile: false` 根目录建 Vite dev
  server，共享磁盘上同一份 `node_modules/.vite` 依赖预构建缓存，前面的文件替后面的文件把它捂热，而
  `app-check.mjs` 跑在最后、受益最大。拆到两台 runner 上之后 app-check 拿到的是冷缓存，跑到 NewAPI 公告合集
  那条用例时触发 Vite 重新预构建，把 90 秒的夹具挂载预算撑爆（run 35420361508）。门禁加了断言钉住这一点。

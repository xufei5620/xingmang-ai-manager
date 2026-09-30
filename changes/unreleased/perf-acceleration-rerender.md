## 用户

- 开着游戏加速时，切到别的页面不再每秒整页重画一次，低配电脑上更省电、更顺手；加速页上的剩余时长照常每秒走。

## 开发

- 加速倒计时不再带着整个界面每秒重渲染（提速清单 R2）：`useAcceleration` 在应用最外层改订阅去掉走表字段（`remainingSeconds`、`sessionSeconds`、`measuredAt`）的快照（`controller.ts` 的 `createClockFreeSnapshotReader`），秒数只由加速页经 `useLiveAccelerationState` 订阅，且只在加速页显示在前面时订阅。加速逻辑、15 秒校准轮询与到期自动停止都没动。浏览器夹具实测（加速中停在首页 10 秒）：重渲染组件从每秒约 208 个降到 0，脚本耗时从 567 毫秒降到 2 毫秒；加速页自身从每秒约 93 个降到 26 个。`browser-check.mjs` 新增回归用例，改前会红。

## 开发

- `e2e/realm-account-smoke.mjs`：主进程求值撞上 V8 回收 inspector promise 时的重试，从固定
  500ms 三次改成带上限的指数退避（500/1000/2000，共四次，上限 4 秒）。次数与退避从
  `e2e/fixture-readiness.mjs` 统一引入，日志每行写明是第几次、等多久、已经等了多久，最终
  失败信息带上总退避时长。此前三次重试会全部落进 Windows runner 同一个忙窗口（run #236
  的三次落在 131.0/131.5/132.0s），额度用光就整个 `windows-package` 红。
- T-G8：这条冒烟的验收证据文件不再写死 `true` 与 `actualNetworkRequests: 0` /
  `generatedContent: false` 这类没有计数器支撑的常量。改成与另外三个证据产出脚本一致的
  `passedAssertions` 写法——每个名字由证明它的那一步记录，收尾断言记录到的名单与预期名单
  一致；数值部分全部从夹具读回（夹具答复数、拒绝数、被拦截的出网尝试、渲染层被拦的来源、
  生成类请求数、隔离探针轮数）。`scripts/ci-workflow-config.test.cjs` 的证据门禁加上这个
  脚本，并新增一条门禁钉住退避参数只能来自共享模块。数值按整条冒烟的三次应用启动累加
  ——每个实例都是新的 Electron 进程、夹具计数器从零开始，只在收尾读一次只会拿到最后一个
  实例的数，那正是 T-G8 要消掉的「看着像度量值其实不是」。

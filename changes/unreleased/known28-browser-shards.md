## 开发

- Windows 的 renderer-v2 夹具浏览器分片从两片加到三片（`renderer-v2-browser-1`～`-3`，各 18 分钟上限不变）。
  10-6 两片各跑 7～10 分钟，最慢的机器上每片每天多半分钟上下，推测 10 月下旬会再撞 18 分钟，所以趁现在拆。
  `app-check.mjs` 的用例照旧按声明顺序轮流发到三片；其余文件按 10-6 三轮 CI 的实测耗时分：
  第 1 片加速 + 公告记忆，第 2 片登录 + 组件 + 对比度，第 3 片聊天 + 键盘 + 账号绑定启动 + 公告。
- Linux 的 `linux-renderer-v2-browser` 不再整份跑 `test:v2:browser:fixture`，改成两个并行作业
  （`test:v2:browser:fixture:linux:1` / `:2`，同样按 `XINGMANG_TEST_SHARD` 发 app-check 的用例，其余文件按 Linux 上的耗时分）。
  10-6 它整份跑要 13～16 分钟，是整轮 CI 最慢的一个作业。作业名、上限 30 分钟和 `quality-gate` 的依赖都没变。
- `ci-workflow-config.test.cjs` 的分片门禁改成 Windows、Linux 两边各查一遍：每份都派发、分母等于份数、
  发牌的文件每份都跑、其余文件只在一份、合起来等于 `test:v2:browser:fixture`；Linux 不许再整份跑一遍。

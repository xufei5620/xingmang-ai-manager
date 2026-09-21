## 开发

- Windows 的 `windows-test (renderer-v2-browser)` 分片在 2026-09-19 至 09-21 的 196 轮 quality 里，141 次完整跑挂了 14 次（9.9%）。逐条取日志后确认指纹只有一个：某一次开页面整个死掉——挂载等待吃满 90 秒、locator 在空文档上吃满 30 秒、或者 `page.goto` 69 毫秒就抛 `net::ERR_NO_BUFFER_SPACE`——而紧挨着的用例都是一两秒。同期十轮绿跑里最慢的用例 22.4 秒，没有任何一条超过 30 秒，也没有任何错误标记，所以这不是预算不够，是导航丢了。
- `e2e/fixture-readiness.mjs` 新增 `fixtureMountAttempts`（默认 3）、`fixtureMountSliceMs()` 与 `openFixturePage()`：90 秒总预算不变，改成分三次导航花掉，一次挂载没落地就重新导航并往 stderr 写明第几次。预算没有调大，用例没有跳过。`src/renderer-v2/testing/app-check.mjs`、`e2e/v2-business.test.mjs`、`e2e/maintenance-layout.test.mjs`、`src/renderer-v2/features/chat/browser-check.mjs` 四个实际红过的套件接上（chat 那份 #265 刚给了预算，这里补上「丢了就重新导航」的另一半）。
- `.github/workflows/quality.yml` 的 `windows-test` 与 `windows-package` 在 `npm ci` 之前把工作目录、`RUNNER_TEMP`、npm 缓存以及 node/npm/chrome/electron 四个进程排除出 Defender 实时扫描；镜像若拒绝只 `Write-Warning`，不会把 Windows 作业整片弄红。
- `scripts/ci-workflow-config.test.cjs` 补两条门禁：两个 Windows 作业都必须在安装依赖前加排除项且自行处理拒绝；夹具导航次数必须 ≥2、单次预算必须大于绿跑实测的 22.4 秒上限、三次合计不得超过总预算，四个套件必须走 `openFixturePage`。另外把 `browserSuitesUnder()` 的发现条件从只认 `.goto(` 扩成也认 `openFixturePage(`——否则把导航交给共享重试的套件会悄悄从这条门禁的扫描里掉出去。
- `docs/TEST-BASELINE.md` 补上 CI 分片这一条的口径，与本机 Windows 基线分开写。

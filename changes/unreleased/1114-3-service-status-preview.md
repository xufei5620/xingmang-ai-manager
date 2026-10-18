## 开发

- service-status 工作流在等批准之前先跑一段 `preview`（#1114 第 3 条）：照这次填的、按现在线上那一份算出「批了以后状态文件是什么样」，写进运行页面的摘要。release 环境的批准发生在 `publish` 开跑之前，以前批的人点批准时看不到这次要改成什么。
  `preview` 不挂环境、不引用 secret、权限照全局只有 `contents: read`，只读客户端也在读的公开状态文件和更新清单，算出来的文件不上传；读线上的三步与 `publish` 一字不差（`scripts/service-status.test.cjs` 钉住）。`publish` 改成 `needs: preview`，环境、并发组、上传步骤不变；填错了在 `preview` 就红，不用白批一次。
- `scripts/service-status.cjs` 两种情况多打一行 `::warning::`、摘要里也写，不拦：这次改的最低版本，包出来不满 24 小时（按线上 `latest*.yml` 的 `releaseDate` 算，工作流新传 `--published-dates`）；同一次运行既清掉还没全放开的分批放量、又改了最低版本。0.2.19 就是发出去 12 分钟时一次运行两样都做了。最低版本原样重填或填 `none` 不提示。

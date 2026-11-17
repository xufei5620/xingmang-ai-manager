## 开发

- 新增 `npm run check:wording`（`scripts/check-customer-wording.cjs`）：用 TypeScript 读 `src/renderer-v2` 和
  `electron` 的源码，挑出会给客户看的字（JSX 里的字、带中文的字符串、标题和读屏标签这类属性），查有没有
  PATH、npm、TOML、环境变量、Sub2API、new-api、站点域名、「站点」和「Key」。先只报不拦：总是以 0 退出，
  CI 的 linux-test 把命中的地方写进作业摘要；放过的几处在脚本里的名单上，每条写明为什么，文字改了对不上时
  `scripts/check-customer-wording.test.cjs` 会红。对照官方「验证」文章的建议第 8 条，界面上的字一个没改。

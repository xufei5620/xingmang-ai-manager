## 开发

- 测试：Windows 上跑的浏览器套件里有七处打开夹具页时只导航一次，那次导航丢了（#806 是加载 `Splash.tsx` 时
  `net::ERR_NO_BUFFER_SPACE`）就对着空页面等满 90 秒再红。登录页、加速页、两份公告、`app-check` 里本机偏好读写不了的那一条、
  账户充值（`e2e/account-commerce-interactions.test.mjs`）和本地头像（`e2e/v2-local-avatar.test.mjs`）都改走
  `e2e/fixture-readiness.mjs` 的 `openFixturePage`：还是 90 秒预算，分成最多三次导航。超时和用例都没动。
- `scripts/ci-workflow-config.test.cjs` 原来只钉手写名单里的五份，现在按 Windows 作业实际跑的套件逐个查，
  新加进 Windows 分片、会开浏览器页的套件不走这一步就会红。

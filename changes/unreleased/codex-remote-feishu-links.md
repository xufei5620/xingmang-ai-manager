## 开发

- Fable 手机遥控 YF-4：「怎么建飞书机器人」六步下面两颗按钮。「打开飞书开放平台」交给浏览器的是 `feishuDeveloperConsoleUrl`
  （`codex-remote-channel.ts`，`https://open.feishu.cn/app`），主窗口外链白名单（`main.ts` 的 `nonSiteExternalUrlAllowlist`，
  I12 全等匹配）多收这一条，yoyo 2026-11-11 亲手打字「飞书网址加」；飞书别的页面、带路径或参数的照样拦下，`main.test.ts` 钉住。
  「看教程」跳 `phoneRemoteTutorialTopic`（`registry/business.ts`，教程那一章的 id 改读它），不是外链。用户行并在
  `codex-remote-fixes-0224.md`。

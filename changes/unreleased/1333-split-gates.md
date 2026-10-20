## 开发

- #1333：#1070 拆大文件以后，三道守安全边界的门禁和测试跟上了，只改测试和门禁，产品行为不变。
- 出包门禁 `scripts/verify-packaged-hardening.cjs` 的「CLI 旧启动链、管理员提权启动链不许回来」两条否定检查，原来只读 `provider-launch-service.js`、门面、上下文和 `windows-elevation.js`，拆家前它读的是整份 `system-service.js`。现在点名查拆出去的全部 13 份（门面、上下文、九个业务簇、`npm-registry`、`npm-command-failure`、`cli-native-package` 三个叶子模块），缺一份就出包失败，不会因为改名悄悄少查；另外 `dist-electron` 顶层所有 `*-service.js` 按名字自动带上，以后再拆出来的服务文件不用回来改单子。在 tsc 加 minify 出来的真产物上跑过，没有误报（合法带 `-Verb RunAs` 的只有 `codex-desktop-appx.js`、`node-runtime.js`，都不在查的范围里）。
- `electron/ipc.test.ts` 的 IPC 策略表测试加两条：四个前缀以外要等账号的 7 条通道点名；日志不是 `normal` 的通道（quiet-success、silent、secret-input、polling）和 `scoped-queued`、`scoped-may-end-session` 两种等账号法逐条点名。#1333 列出的十种照抄邻居一行的改错，现在逐条改表都会红。
- `ipc.ts` 撤通道时的三项收尾各加一条测试：退出时擦掉还没到 60 秒的剪贴板密钥、放掉换线路定点改写拿着的账号钩子、清掉反馈报告预览。删掉任意一行都会红。

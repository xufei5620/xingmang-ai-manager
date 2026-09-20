## 开发

- 修 `publish-release.yml` 的 macOS 出包作业漏了编译主进程：`prepare-acceleration-bundle.cjs` 用的是主进程里那套安全读写与内核校验，没有 `dist-electron` 就在第一秒报「请先编译主进程」。2026-09-20 的首次正式发布就红在这里——Windows 那半条有这一步，照抄到 macOS 时漏了。`scripts/publish-workflow-config.test.cjs` 补了一条断言：两个出包作业都必须在准备加速资源之前编译主进程（去掉修复后这条会红）。

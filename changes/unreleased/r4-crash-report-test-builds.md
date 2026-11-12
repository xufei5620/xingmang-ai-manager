## 开发

- 崩溃上报不再把测试数据记进正式版名下（R4）：本机和 `test-build.yml` 出的快包（`xingmangLocalBuild`）、
  GitHub Actions 里起的打包版（`CI=true`）不再报 Sentry，和每天打卡同一条规矩（`crash-report.ts` 的
  `shouldReportCrashes`）；`package-for-testing` 出的测试包照样报，但 environment 记成 `testing`
  （打包时写进 `xingmangTestingBuild`：Windows 那份由工作流设 `XINGMANG_TESTING_BUILD=1`，macOS 那份
  按一次性身份签名认出），正式包仍是 `production`。`publish-release.yml` 不许出现这个标记，Mac 出包脚本
  把继承来的同名变量清掉。说明见 `docs/RELEASING.md` 第 9 节。

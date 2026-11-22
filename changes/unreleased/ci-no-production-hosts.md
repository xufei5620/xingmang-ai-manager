## 开发

- CI 里真开的星芒不再连正式环境：服务端 11-21 核对装机量，一天里有 275 台「Linux 电脑」只请求 xm.solov.cc 的
  `/api/status`，来源全是 GitHub Actions，就是 quality 的 linux-package 装好 deb 以后真开的那两步；Windows、Mac 作业里
  没挡网的真开（renderer-v2-native、装好的包冒烟、macOS 发版演练）也一样。新加 `scripts/ci-block-production-hosts.cjs`：
  从客户端源码里找出 `solov.cc`、`shenfengwl.fun` 下面的全部域名（账号站、两条线路、更新目录等 10 个），在 runner 的 hosts
  里指回本机，再逐个解析确认生效才往下跑。quality 的 windows-package、macos-test、macos-release-rehearsal、macos-intel、
  linux-package 和 package-for-testing 的 macos-package、linux-package 都在真开之前跑它；
  `scripts/ci-block-production-hosts.test.cjs` 扫全部工作流，真开星芒的作业没先跑它就红，例外（旧版升新版冒烟自己断网；
  发版那几个作业要先读线上更新目录）各写了原因。
- 兜底：`CI=true` 时客户端把 `app.userAgentFallback` 末尾加上「 ci」（`electron/ci-user-agent.ts`，口径同每天打卡、版本上报、
  错误报告），所有会话的请求都带它，服务端和 update-feed-stats 认这个后缀就能剔掉漏网的 CI 请求。客户电脑上不变。

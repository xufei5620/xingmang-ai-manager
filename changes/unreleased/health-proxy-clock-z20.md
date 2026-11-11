## 开发

- 检查页 D33（汇总决定单批次 Z20，代理.md PX-10，yoyo 11-11「决定单照推荐」，字照决定单原文）：`proxySettingsOutcome` 在本机代理
  没开、桌面端也看得见这条设置时（Windows 当前账号下那一条，或读不到设置；Mac 一律算看得见；Linux 没有 Codex 桌面端，不标）给
  PROXY_ENVIRONMENT 的 details 加 `reachesDesktopApps: true` 和 `port`；`reconcileProxySettingsWithDesktop` 在全部查完后对着
  CODEX_DESKTOP 那一项，装着就把结论换成「……从星芒打开的命令行工具会自动绕开它；Codex 桌面端这类桌面软件绕不开，会连不上，
  要把这条旧设置清掉。」，「清掉这条旧设置」照旧给。Windows 上两边都读到了、都没有的（这一次启动星芒时带进来的，资源管理器
  打开的桌面端看不见）和整台电脑那一条（决定单没给说法）照旧。两项同时跑，放在结束后对，不为它多探一次桌面端。
- 检查页 D34（代理.md PX-9）：Mac 上没看到另外设的代理时不再说「没有另外设过代理」，改说终端设置里的代理星芒看不到、工具会用它；
  `proxySettingsOutcome` 多一个可选 `platform`，不给照旧。
- 检查页 D56（时间数字格式.md N-6）：「星芒 AI 网络」系统时间差的那句换成 `clockSkewSummary`：不到 1 小时说分钟、不到 2 天说小时、
  再多说天，说清快了还是慢了；离 1~23 个整小时不到 5 分钟时补「多半是时区设错了」。`details.clockSkewMinutes` 照旧。

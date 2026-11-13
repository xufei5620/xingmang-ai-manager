## 用户

- 检查页少亮几盏不用管的黄灯：Mac 上「电脑里的代理设置」不再一看到代理就亮黄灯，先试一下这个代理开没开，开着就显示正常，
  没开的，从星芒打开工具、安装工具时都会自动绕开它；「电脑里另外设过的工具地址或密钥」如果盖不过当前账号的设置
  （比如给别的程序用的密钥），改成显示正常，不再放在「需要处理」里，也不用去删。
  检查页还会看一眼 Claude Code 自己设置里写死的代理，代理关了它会连不上时直接说出来。

## 开发

- 检查页 PROXY_ENVIRONMENT（yoyo 11-06「体检改」）：Mac、Linux 原来走 `otherProxySettingsOutcome`，只数进程环境里设了几个
  （连 NO_PROXY、FTP_PROXY 也算），代理开着也是 warn，详情列「HTTP_PROXY (process)」。改成三个系统都走同一个
  `proxySettingsOutcome`（原 `windowsProxySettingsOutcome` 改名）：指向本机的先试连，开着 pass、没开 warn「从星芒打开的工具会
  自动绕开它」、指向别的机器 warn，用的都是 Windows 现成的三句；`readScopes` 只有 Windows 给，Mac、Linux 不给「清掉这条旧设置」。
  `DiagnosticsDependencies.inspectProxyVariables` 和 `ProxyVariableSummary` 随之删掉，测试改注入 `probeLoopbackProxy`。
- 装工具时 npm 的环境 Mac 上也过 `withoutDeadLoopbackProxies`（`cli-install-service.ts`）：从终端启动或 launchctl 里设过时，
  星芒自己的环境里带着代理，没开就一样装不上，检查页那句「会自动绕开」要对装工具也成立。打开工具那一半 Mac 上原本就由
  `buildMacosClosedProxyGuard` 管。照系统代理替 npm 补上的那几条（`resolveSubprocessProxyEnvironment`）三个系统都单独再判一次：
  代理软件关了、系统设置里还勾着本机端口时交给 npm 的也是连不上的地址，而且它排在后面会盖过环境里那几条。日志
  `proxy-env.bypassed` 对这一种多带 `from: 'system-proxy'`，好分清来源（Mac 真机安装日志里见过 ECONNREFUSED 127.0.0.1:7890，
  来源没定位）。
- PROVIDER_ENVIRONMENT_OVERRIDE：实测盖不过写入配置的那几个（`breaksAccount: false`：ANTHROPIC_BASE_URL、ANTHROPIC_AUTH_TOKEN、
  OPENAI_BASE_URL、OPENAI_API_KEY，以及指到别处的 CODEX_HOME）不再报 warn「可能会盖过当前账号的设置」，改成 pass「电脑里另外设的
  工具地址或密钥盖不过当前账号的设置，不影响使用」；Windows 上只剩这种时也就不再给「删掉这几项设置」。2026-11-06 用 Codex 0.164.0、
  0.166.0、0.167.0 和 Claude Code 2.1.310 对本地假接口重测过：环境里设了这几个，请求照旧发往写入的地址、带写入的密钥。
  pass 时变量名改放 `details.reportOnlyVariables`（`diagnostic-details.ts` 没给它中文名，检查页不上屏，导出报告里照旧有），
  原来「已指向当前账号」那种 pass 也一样；有会绕开当前账号的变量时详情照旧逐个列 `variableN`。

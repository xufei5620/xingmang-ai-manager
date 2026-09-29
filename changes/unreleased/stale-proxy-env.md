## 用户

- Windows 上以前照教程设过代理、后来代理软件关了或卸了的，从星芒打开的工具和装工具时会自动绕开这个没开的代理，直接联网，不再一串英文连不上。你的电脑设置不会被改动。
- 检查页那一项改叫「电脑里的代理设置」，说清楚代理开没开；代理没开且是你这个账号下设的，可以点「清掉这条旧设置」，点之前会先确认。整台电脑的那一份要管理员才能改，只说明不动。

## 开发

- 第十六批 5：新增 `electron/stale-proxy-environment.ts`。`HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`（大小写都算）指向本机端口时 300 毫秒试连，连不上的这一次不带；开着的、指向别的机器的、认不出的照旧带。Windows 打开工具（`launchCliPowerShell` 的环境）和 npm 安装（没开加速时的基础环境）都走它，只减不增，探测出错原样返回；日志 `network/proxy-env.bypassed` 只写变量名和端口。已核实 npm 的 `@npmcli/agent` 读 `https_proxy` / `http_proxy`；各 CLI 认哪几个名字按公开说明推测，未逐一核实。
- 检查项 `PROXY_ENVIRONMENT` 在 Windows 上改为 `windowsProxySettingsOutcome`：分没设、本机代理没开（当前账号可清 / 整台电脑 / 读不到）、本机代理开着、别的机器几种说法，details 不带原值。「去处理」不再落到设置页。macOS 保持原样。
- 新 IPC `diagnostics:clear-stale-proxy`（无入参）：主进程点的那一刻重新读 `HKCU\Environment` 与机器级、重新试连，只删当前账号下指向没开本机代理的那几条（名字经环境变量传给 PowerShell，脚本内再对照固定名单），不碰机器级、不提权；清完同步本进程环境。

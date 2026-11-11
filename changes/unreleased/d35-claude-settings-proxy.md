## 开发

- 检查页 D35（汇总决定单批次 X09，代理.md PX-4，yoyo 11-11「决定单照推荐」= 「D35 改」不加按钮，结论照决定单原文）：
  `buildProxyChecks` 在「电脑里的代理设置」后面加一项 CLAUDE_SETTINGS_PROXY「Claude Code 自己设置里的代理」。经 `readSafeUtf8File`
  读 `providerConfigRoot('claude')/settings.json`（256 KB 上限），`claudeSettingsProxyVariables` 只取 env 段里 HTTP_PROXY / HTTPS_PROXY /
  ALL_PROXY 三个名字（大小写都认）的字符串值，`claudeSettingsProxyOutcome` 照 `inspectProxyVariables` 同一套规则试连：有指向本机又没开的
  才出这一项、亮黄灯（「Claude Code 自己的设置里写了一个代理，它现在没开，Claude Code 会连不上。」），details 只写变量名和端口；
  没写、开着、指向别的机器、没有这份文件都 `omit`。读不了或不是正经 JSON 的也 `omit`，原因只进日志：「Claude Code 跑命令前要不要先问你」
  读同一份文件，会在那一项报出来。不给按钮、不动文件（那是客户自己设的值）；渲染层不用改，`diagnosticTarget` 对它照旧给 null。
  决定单没给行名和正常时的字：行名取原文里的字拼成，正常时这一行不出。
- 更新说明「## 用户」这一版已满 60 条，这条只写开发。

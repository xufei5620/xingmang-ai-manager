## 开发

- 0.2.25「其他方面核查」第 1 条（严重）：S01 的更新安装交接脚本在 PowerShell 受限的 Windows 电脑上一行都跑不起来，
  以前报「可能是 Windows 授权窗口被关闭，请点击「重新安装」重试」，可授权窗口根本不弹，重试永远一样。
  Windows CI 实测（运行 45648962353）：机器级 `__PSLockdownPolicy=4` 的受限语言模式下脚本停在开头第一处 `[IO.Path]::Combine`，
  组策略把执行策略定成 AllSigned 时 `-ExecutionPolicy Bypass` 压不过、脚本不让加载；两种都约 300 毫秒以 1 退出、不写状态、不请授权。
- 处理（产品负责人 11-25 选核查里的 C）：装法和核对一点不放宽，只把这种失败认出来，引导客户去下载页手动装一次。
  `windows-update-handoff.ts` 把 `-Relaunch` 那一份的退出码 1（`windowsHandoffBlockedExitCode`，脚本自己从不以 1 退出）判成新的结果 `blocked`，
  并在交接记录里记 `blocked: true`；`updater.ts` 报新代码 `UPDATE_HANDOFF_BLOCKED` 和新句子 `updateHandoffBlockedMessage`；
  退出时自动装碰上的（那时星芒已经退了），下次打开由 `bootstrap/updates.ts` 从记录认出来，直接报同一个代码和句子（`previousAutoInstallFailure` 可以连代码一起返回）。
  渲染层 `update-retry.ts` 的 `updateNeedsManualReinstall` 认这个代码：版本更新卡、首页气泡、强制更新那层都去掉「重新安装」、给「打开下载页」；
  版本更新卡右上角在这两种只能手动装的情况下不再写「已下载，重启后生效」，退回按阶段的那句、用提醒色（Mac 验签不过同样受益）。
- 用例：`windows-update-handoff.test.ts`（退出码 1 判 blocked、记下、下次打开认出；脚本里没有任何一处以 1 退出）、`updater.test.ts`、
  `update-retry.test.ts`、`required-update.test.ts`；`e2e/windows-update-handoff-smoke.mjs` 在 Windows 打包作业里真设一次受限语言模式、
  一次组策略 AllSigned，照星芒的发起方式走交接，断言结果是 blocked、没有提权的那一份起来，跑完都改回。
- 没做：让脚本本身适配受限环境（核查里的 A）放下一版，由 Claude·win 牵头；组策略只许签名脚本的电脑 A 也解决不了。

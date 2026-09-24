## 用户

- Mac 上装了 Xcode 但还没同意它的许可协议时，首页「运行环境」的 Python 一行不再显示一整段英文，Git 一行也不再圆点是绿的却写着「未装」：两行都按没装处理，首页照常给出安装 Python 的按钮；检查页和外接工具页（装 Claude Code 插件、查扩展更新时）用大白话说明原因，告诉你打开一次 Xcode 点「同意」或者另装一份就好，不再叫你去装已经装好的开发者工具。

## 开发

- `macos-command-line-tools.ts` 新增 `inspectCommandLineToolsShim`：确认 `/usr/bin/git`、`/usr/bin/python3` 背后那份存在后，再试跑一次 `--version`，失败就不算可用；stderr 是 xcrun 的「You have not agreed to the Xcode license agreements」时回 `license-pending`。`isCommandLineToolsShimBacked` 改为它的布尔包装，首页扫描、检查页、外接工具页三处调用方自动跟上。以前 Xcode 许可没同意时空壳不弹窗、只吐这句英文并以 69 退出，`system-service.ts` 的 `executeVersion` 在失败分支把 stderr 第一行当成版本号，于是整段英文上了首页；0.2.9 已是如此，不是 0.2.10 回归。
- 检查页 `DiagnosticToolStatus` 新增可选 `xcodeLicensePending`，Git / Python 两行给 `xcodeLicensePendingNotice` 的说明，不提 sudo、不叫客户开终端。
- `provider-extensions.ts`：服务与更新检查器新增可注入的 `inspectCommandLineToolsShim`（与原布尔注入并存，给了以它为准），`claudeMarketplaceGitMissingMessage` 新增 `xcodeLicensePending` 选项；许可没同意时插件市场与扩展更新检查的报错改用 `xcodeLicensePendingNotice`，不再说「先装命令行开发者工具」。

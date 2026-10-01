## 用户

- 安装或更新 Claude Code、Codex CLI 时，如果网络不稳导致主程序没下载完整，现在会如实提示「没有下载完整」，并自动换下一个下载源再试；不再显示「安装完成」后一打开就闪退。已经装坏的，关掉代理或换个网络后点「重新安装」即可恢复。

## 开发

- 新增 `electron/cli-native-package.ts`：按包自己的 `optionalDependencies` 找本平台的原生包（Claude Code 的 `-darwin-arm64` 等、Codex 的别名包），装完在暂存前缀里核对它真的在，缺了就记 `cli.install.native-package-missing` 并让这个源失败、换下一个源；非托管安装在最终校验时再查一次。根因：npm 下载可选依赖失败时静默跳过、退出码仍为 0，原来只核对版本号（10-1 客户 Mac 两步都只 `added 1 package`）。npm 11.19 的 allowScripts 提示只是警告，postinstall 照常执行，不是原因。

## 用户

- 首页点「安装 Git」后，会先确认 Git 真的能用了再说「装好了」。如果被安全软件或公司电脑的管理规定拦下，会直接告诉你没装上和怎么办，不会一边说装好了、一边还显示缺 Git。

## 开发

- `electron/git-runtime-install.ts` 新增 `verifyInstalled` 回查：安装程序退出 0 后由 `system-service.ts` 的 `inspectGit()` 找一遍 Git（含代装的两个固定目录，不依赖本进程 PATH 刷新），找不到或回查抛错即报 `gitRuntimeMissingAfterInstallMessage` 并失败，不再换源重装；找到时结果里的版本取回查值（Fixes #549，codex-win R02）。

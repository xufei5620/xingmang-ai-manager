## 用户

- 卸载星芒时，会顺手收回软件写进 Claude Code、Codex、Gemini CLI、Grok 里的提醒设置（做完、出错时弹通知，干活时不让电脑睡着的那几行），卸了以后这些工具不会再每一轮都多报一行错。Key 和其余设置照旧留着，卸了星芒工具照样能用。卸载窗口的细节里会多一行「收回写进 AI 工具里的提醒设置」。
- 卸载后换了文件夹重装、在 Mac 上挪过软件、或者重新装过 Node.js，工具里的提醒设置还指着以前的位置时，首页那一行会显示「提醒设置要修」，旁边一颗「修好它」。点了会先备份原来的设置（在「备份」里能找回），再只改这几行，改完再查一遍。工具照样能直接打开。

## 开发

- 第十八批候选 1（1、3 退一步的方案；开机自动改路径 1b 待 yoyo 点头，本次不做）。
- `cli-hooks.ts` 新增 `splitManagedCommand` / `managedCliHookTargets` / `cliHookTargetsStale`：把我们写的钩子、状态行、Codex notify 拆回「程序 + 脚本」，程序或脚本不存在、或脚本不是这次安装带的那份（同名比对，Windows 不分大小写）即判为旧位置。
- `config-files.ts` 新增 `inspectManagedCliHookTargets`、`rewriteManagedCliHooks`（只改我们那几条；写不出钩子时收回）、`removeManagedCliHooks`（卸载用），写入仍是两阶段提交 + `.bak`；原来没有我们那几条的配置一个字不动。
- `NativeConfigSummary.cliHooksStale`；新 IPC `config:repair-cli-hooks`（先建「备份」页可见的 pre-save 备份，再改，再复查，没修好抛中文原因）。首页状态 `cliHooksStale`「提醒设置要修」+「修好它」，优先级排在来源类提示之后；「打开」不受影响。
- 卸载清理 `runUninstallCleanup` 加 `removeCliHooks` 一步（退出码位 64 `cliHooksRemain`，失败不拦卸载；别的账号卸载时不动）。以管理员身份跑，Codex 目录刻意不读 `CODEX_HOME`。

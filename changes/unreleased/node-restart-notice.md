## 用户

- Windows 上自动装完 Node.js 后，如果系统要求重启电脑才能装完，会直接说「装好了，重启电脑后就能用」并给一颗「现在重启」按钮，关掉就是稍后自己重启；不再笼统地只说一句「已准备」。
- 刚装好的 Python，从本软件打开的命令行工具马上就能找到，不用重开软件。

## 开发

- 第七批 5：渲染层接上 `installNodeRuntime` / `installPythonRuntime` 返回的 `systemRestartRequired`（MSI 3010）。文案在 `features/tools/runtime-install-outcome.ts`，首页（`App.tsx` 的 `installRuntime`）与「安装卸载」页共用；重启框 `features/tools/RuntimeRestartDialog.tsx` 只有一颗按钮、打开时焦点不在按钮上，发之前查渲染层未完成的业务操作。
- 主进程 `restartWindows` 在安装队列忙时拒绝发 `shutdown /r`，避免倒计时结束把正在原子替换的安装打断（I11）。`runtime:restart-windows` 通道此前注册了但没有调用方。
- `pathRefreshRequired` 不再提示用户重开：`command-runner.ts` 的 `commandEnvironment` 在继承 PATH 之后补上代装 Python 3.12 的目录与 `Scripts`（排最后，不顶掉用户自己的 Python）；Node.js 的固定目录本来就在 `defaultCommandPaths` 里。只影响同用户模式，`trustedCommandEnvironment` 不变。

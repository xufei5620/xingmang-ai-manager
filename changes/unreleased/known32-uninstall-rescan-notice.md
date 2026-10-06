## 用户

- 在首页卸载工具，其实已经卸掉了、只是紧接着没读到最新状态时，不再弹红色的「操作没有完成」，确认框照常关掉，
  改出一条黄色提示「Claude Code 已卸载，但最新状态没有读到。请重新检测，无需重复卸载。」（工具名照实写）。

## 开发

- 已知32：`App.tsx` 的 `requestUninstall` 记下主进程回的是不是 `uninstalled`；是的话紧接着的 `toolbox.refresh(true)`
  没读到只出 warn 提示、不往外抛，确认框照常关。`delegated`（以管理员身份运行时交给命令窗口）、`manual-required`、
  `not-installed` 照旧当没做完。首页顶上检测自己的那句「检测没有完成，请重试。」照旧。

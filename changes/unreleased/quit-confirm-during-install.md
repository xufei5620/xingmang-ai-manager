## 用户

- 安装或更新命令行工具的过程中退出程序时，会先确认一次「还在安装，现在退出会中断」，
  选「继续安装」就留在原处；没有安装在跑时退出行为不变。窗口关闭方式设成「直接退出」
  以及从托盘菜单点「退出」都会确认，系统关机或注销不会被拦住。

## 开发

- `electron/quit-blocking-tasks.ts` 新增纯函数 `resolveInterruptibleInstallTask`，
  从 `InstallationQueue` 的快照里认出安装类任务（`cli:install:*`、`runtime:node`、
  `runtime:python`、`desktop:codex:install`）并给出中文说明；启动 CLI、打开桌面端和
  卸载被打断没有后果，不在拦截范围内。
- `window-lifecycle.ts` 新增可选的 `confirmQuitWhileBusy`（缺省 = 旧行为）：
  「直接退出」偏好与托盘 / 菜单「退出」在放行前调用它，「每次询问」那条路径不调用，
  因为它自己的对话框已经写了「强制退出不等待任务完成」。确认框抛错不否决退出。
- 同一改动里让 lifecycle 监听 `session-end`：Windows 关机 / 注销时直接放行，
  包括确认框已经弹出来之后才收到该事件的情况。
- `SystemService` 新增 `inspectInstallationQueue()` 暴露队列快照。第六批候选 8。

## 用户

- 装工具、装 Codex 桌面端、准备 Node.js / Python / Git 和后台下载新版本的时候，电脑不会再自动睡着把下载打断；屏幕照样按你的设置关，装完就恢复平常的睡眠设置。

## 开发

- 新增 `electron/install-keep-awake.ts`：安装队列里有下载/安装类任务（`runtime:node|python|git`、`desktop:codex:install`、`cli:install:*`、`external-client:install:*`）或更新器处于 `downloading` 时持有 `powerSaveBlocker('prevent-app-suspension')`，结束、失败、取消即放开，每个原因最多挡两小时（与 `cli-keep-awake.ts` 同一上限）。`InstallationQueue` 加 `onChange`，`SystemService` 暴露 `onInstallationQueueChange`。日志 `install.keep-awake.held` / `.released`。第二十二批 ①。

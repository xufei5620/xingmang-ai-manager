## 用户

- 新增「自动更新」开关，默认开着：有新版本时在后台下载好，等你关掉软件或下次打开软件时自动装上，不会在你正用着的时候重启。开关在新版本提示里和「设置」里都有，关掉后回到原来的方式，先提醒你，由你点安装。

## 开发

- `app-settings.ts` 新增 `autoUpdate`（缺省开，只落盘显式关闭）。`updater.ts` 每次决定下载前现读这个开关；新增 `scheduledCheck`（定时检查找到新版本顺手下载）、`autoUpdateChanged`（打开开关时开始下载已找到的版本）、`autoUpdateEnabled`，快照多一个 `autoUpdateSupported`。
- 未签名通道（Windows）经 `unsignedAutoUpdate` 放开自动下载与自动安装，yoyo 2026-09-25 亲口同意；撤回名单、分批放量、SHA-512 复核照旧生效。
- 安装时机由新模块 `auto-update-install.ts` 决定：退出时直接装、不再弹「顺手装上吗」（装前最多等 3 秒重读撤回名单）；上一次运行就下好的版本在下次启动两分钟内装上，每个版本只在启动时试一次，记录在 `%APPDATA%\xingmang-ai-manager\pending-update.json`，防止安装器坏掉时每次打开都闪退。
- legacy 旧界面已冻结，更新页里「每次下载和安装前都会先问你」那句没有改。

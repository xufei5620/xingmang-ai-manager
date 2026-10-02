## 开发

- Linux 版界面与系统细节（出 Linux 版拆分第 ⑩ 步）。Linux 还没对外发，这条不进更新说明；Windows、Mac 的界面、文案和
  行为不变，相关测试按平台钉住。
- 托盘：启动时用固定路径的 `/usr/bin/dbus-send`（退到 `/usr/bin/gdbus`）问会话总线有没有
  `org.kde.StatusNotifierWatcher`（`electron/linux-tray-host.ts`），没有就不建托盘、关窗直接退出，设置页「点关闭按钮时」
  说明原因，开机自启时直接弹窗。原版 GNOME 上 `new Tray()` 成功但图标不显示，窗口缩进去就找不回来。
- 开机自启：Linux 写 XDG 的 `~/.config/autostart/xingmang-ai-manager.desktop`（`electron/linux-autostart.ts`，Exec 按
  Desktop Entry 规范加引号、带 `--launched-at-login`，读写走 safe-local-data），系统里被停用时报「登记了但没生效」。
- 不要应用菜单；窗口图标用 PNG；Wayland 会话启动前加 `--enable-wayland-ime --wayland-text-input-version=3`
  （`electron/linux-ime.ts`）；渲染进程崩溃框和「窗口已收起」通知改成 Linux 的说法。
- 平台能力加 `acceleration`（Linux 为 false）：侧栏、搜索、托盘菜单、设置里的加速提醒都不出现，不发加速请求。
  Codex 桌面端行和外部客户端在 Linux 上不显示；新手引导在 Linux 上默认推荐 Codex CLI。
- 教程按电脑分版本（`registry/tutorials.ts` 的 `tutorialTopicsFor`）：Linux 第一章换成 Codex CLI，更新一步按 ⑧ 的系统
  安装窗口口径写，去掉桌面端、加速和 Mac 专属章节；Git、Python 缺了给 apt 命令。
- 读 `/etc/os-release`（`electron/linux-os-release.ts`）：检查页「操作系统」、「复制给客服」和启动日志带发行版名字，
  日志另记桌面、x11/wayland、有没有托盘。`WindowCapabilities` 加可选的 `systemLabel`，没有新增 IPC 通道。

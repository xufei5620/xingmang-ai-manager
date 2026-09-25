## 用户

- Mac 菜单栏里的「撤销」「复制」「粘贴」「退出星芒AI管理工具」等菜单项改成中文；Windows 安装、卸载窗口「显示细节」里的英文提示也换成了中文，覆盖安装时软件还开着会直接告诉你先退出软件再装。

## 开发

- `electron/window-presentation.ts`：macOS 应用菜单每个 role 项补中文 label，role 保留，快捷键与系统行为不变（第十三批 10）。
- `build/installer.nsh`：卸载清理与覆盖安装文件被占用时的 DetailPrint / Abort 文案改中文；退出码单独一行「排查用代码」，退出码 32（换管理员账号卸载，uninstall-cleanup.ts 的 otherAccount）单独说明。`scripts/windows-installer-uninstall-cleanup.test.cjs` 钉住所有 DetailPrint / Abort 都含中文、32 与 otherAccount 一致。

## 开发

- 安装到 Program Files 以外（比如 `D:\星芒AI管理工具`）时，安装程序把安装目录改成跟 Program Files 下一样只有管理员能改（`build/installer.nsh` 的 `xingmangLockInstallDirectory`，权限串 `XINGMANG_INSTALL_DIRECTORY_SDDL`：属主 Administrators，不再继承上级，SYSTEM/Administrators 完全控制，Users 与两个应用包组只读和运行）。原因：自选目录继承盘根的「已验证的用户可修改」，而以管理员身份跑的升级会执行旧卸载程序、卸载会执行主程序、更新器会执行 `resources\elevate.exe`，谁都能先换掉这些文件，等客户下一次更新点「是」时拿到管理员权限（Codex 逆向报告第 3 条，2026-10-08 核对；0.2.15 起就有）。
- 收紧在三处做：`customInit`（升级、静默安装时 `$INSTDIR` 已定，赶在模板执行旧卸载程序和解压之前）、目录页离开时（有界面安装，当场建目录并收紧）、`customInstall`（兜底）。只在按整台电脑安装时编进去；Program Files 和网络路径不动。
- 改权限前先不跟链接地打开目录（`FILE_FLAG_OPEN_REPARSE_POINT`，不许别人同时删、改名），核对最终路径与 `$INSTDIR` 一字不差、它是真文件夹不是重解析点，再经同一个句柄 `SetSecurityInfo`；任何一条不对就不改、照原样安装。不起 icacls 或 PowerShell（I14）。
- 新增 `scripts/windows-install-directory-acl-smoke.ps1`，接在 `windows-uninstall-smoke.yml` 里：Program Files 安装不变；装进「已验证的用户可修改」的文件夹后目录和主程序、卸载程序、`elevate.exe` 只剩管理员能改；把它还原成老版本留下的宽松权限、放进一个指向外面的联接再按更新器的方式升级，重新收紧，联接后面的文件夹权限不变。

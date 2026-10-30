## 开发

- `electron/windows-elevation.ts`：Windows 上 `whoami /groups` 一次运行只起一次（0.2.22 性能体检第 2 条，报告 `/mnt/project-files/0.2.22-性能体检.md`）。
  开机以前问两遍：判断 CLI 执行边界（`inspectCurrentWindowsIntegrityRid`）一遍，判断更新能不能自动装（`inspectWindowsElevationCapability`）又一遍，
  问的是同一个令牌，跑这个进程期间不会变。现在 `readCurrentWindowsTokenGroups` 由 `createCurrentWindowsTokenGroupsReader` 包一层：
  答出来的原样记住，后面一键检测、装 Node.js、装 Codex 桌面端问到的也是它；同时在问的几处共用一次。失败（超时、起不来）不记，
  下一个照旧重问。调用方的 abort 信号只结束它自己的等待，不交给 whoami，一键检测放弃了不会连累同时在等的安装。
  两个 parse 函数和执行边界的判断都没动。

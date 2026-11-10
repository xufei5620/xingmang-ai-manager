## 开发

- 0.2.24 深查 D81（`0.2.24-深查/高分屏窗口.md` W-11）：Windows「设置 › 辅助功能 › 文本大小」调大以后，系统弹框和托盘菜单的字跟着大，
  界面里的网页内容不吃这一项。现在 Windows 上开机时异步读一次 `HKCU\Software\Microsoft\Accessibility` 的 `TextScaleFactor`
  （新模块 `electron/windows-text-scale.ts`，照 `windows-taskbar-theme.ts` 的读法：System32 的 reg.exe 绝对路径、最小环境、
  `execFile` 异步、读不到当没调过），和迁移、执行模式探测叠着跑；建主窗口前已经读回来、大于 100%，且客户没定过字的大小时，
  写入 `largeText: true`（判断在 `window-preferences.ts` 的 `shouldFollowSystemTextSize`）。建窗口不等它，没读回来这次就不管。
- `AppSettings` 加 `textSizeChosen`（只落 true）：`mergeAppSettings` 里任何一次写入带了 `largeText` 或 `uiScale` 就记上，
  包括关掉「大字」、选回「自动」、「恢复默认外观」和替客户自动开的那一次，所以客户关掉以后不会被再打开。老版本没有这个字段，
  已经手动关过「大字」的老客户第一次会被开一次，关掉就不再开。`ui-spec/03-layout-window.md` §1 跟着补了一段。

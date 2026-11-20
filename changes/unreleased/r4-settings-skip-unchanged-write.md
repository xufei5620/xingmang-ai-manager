## 开发

- 开机不再白写一遍 settings.json（总单 77，0.2.24 性能深查 R4）：`updateAppSettings` 合并后跟磁盘上一字不差就不写，
  跟开机那次整理 `normalizeAppSettings` 用同一个口径（两处共用 `writeSettingsIfChanged`）。界面每次开机发的那次
  `window:set-theme`、关窗存的窗口位置，没变时都不再走临时文件、fsync、拷 .bak、改名。
- `window:set-theme` 先换窗口颜色再记设置；记不进去（C 盘满、杀毒锁住文件）只在运行日志记一条
  `window.theme.save-failed`，不再让标题栏和页面停在旧颜色、再弹一张「系统外观没有同步」。
- 用例：`electron/app-settings.test.ts` 补「没变就不碰文件、不建 .bak、不调替换钩子」「没变的那次在写不进去时也不失败」两条，
  `electron/ipc.test.ts` 补「先换颜色再记、记不进去只记日志」一条，三条在旧代码上都红；另补一条守住「主文件坏了照样重写」。

## 开发

- 主窗口开着时不再每 0.5 秒 stat 一次 settings.json（总单 77，0.2.24 性能深查 R5）：`app-settings.ts` 每次把设置文件换成新内容后
  通过 `onAppSettingsWritten` 通知一声，`platform/renderer-v2.ts` 的界面缩放改为订阅它，关窗退订。内容没变不写，也就不通知；
  监听器抛错不影响那次写入。缩到托盘以后也不再有这个亚秒级的磁盘轮询。手改 settings.json 里的缩放，下次拖动窗口或重开时生效。
- 用例：`electron/app-settings.test.ts` 补通知的两条（换了才通知、没变和写失败不通知、退订后不再通知；监听器抛错不影响写入和别的监听器），
  新增 `electron/platform/renderer-v2.test.ts`（存了缩放马上跟上且不再 `fs.watchFile`；关窗后不再跟），三条在旧代码上红。

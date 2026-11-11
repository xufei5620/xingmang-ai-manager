## 开发

- 设置 › 消息通知「发测试通知」（决定单 D68、深查 通知弹窗.md NT-6）：系统里把星芒的通知关了（Windows 专注助手、Mac「系统设置 › 通知」），
  Electron 的 `show()` 大多照样不报错（Mac 上一般静默），原来那句「已发送一条测试通知」会骗客户。改成提示条
  「已经交给系统了。没看到通知的话，去系统的通知设置里看看星芒有没有被关掉。」，Windows、Mac 上带一颗「打开系统通知设置」，
  打开了提示条才收起；没打开就留着，再补一条「没能打开系统通知设置，请在系统设置里找「通知」。」。
- 新通道 `xingmang-platform:open-notification-settings`（`platform/contract.ts`、`platform/preload.ts`、`platform/ipc.ts`），不带参数、回 `boolean`：
  打开哪一页由主进程定死（`platform/system-service.ts` 的 `notificationSettingsTarget`：Windows `ms-settings:notifications`，
  Mac `x-apple.systempreferences:com.apple.Notifications-Settings.extension`，Linux 回 null 不打开），经 `shell.openExternal` 交给系统，
  渲染层给不出网址（I12），带参数一律拒；日志记 `opened`。只服务主窗口，跟同一组其他通道一样过 `assertPlatformOwner`。
- 主进程把通知的 `failed` 事件回传给「发测试通知」（NT-6 第三条建议）这次没做：决定单 D68 只定了说法和按钮。
- 更新说明「## 用户」已到 60 条上限，这条不进更新页。

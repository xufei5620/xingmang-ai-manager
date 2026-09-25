## 用户

- 软件里点右键终于有菜单了：在输入框里可以「剪切、复制、粘贴、全选」，选中文字后可以「复制」，在链接上可以「复制链接」。以前右键没反应，只能用快捷键。

## 开发

- 主窗口接上 `context-menu`（`electron/context-menu.ts`）：菜单项走 Chromium 的 cut/copy/paste/selectAll role，按 `editFlags` 置灰（密码框不能复制、剪切），不用放开剪贴板读取权限；只给 http(s) 链接「复制链接」，不提供「打开」，免得绕开导航白名单；不加「检查元素」。渲染层自己 `preventDefault` 的右键（聊天图片菜单）不受影响。画布窗口不在这次范围内。

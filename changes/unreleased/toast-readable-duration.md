## 用户

- 屏幕下方的提示条按字数停留：短的「已复制」这类和原来一样快，长的会多停几秒；鼠标放上去就不会消失。黄色和红色的提示不再自己消失，右边多一个 ×，点了才关。

## 开发

- `src/renderer-v2/ui/feedback.tsx`：新增 `toastDurationMs`（2.4 秒起，超过 12 个字每字加 0.2 秒，最长 10 秒；`warn` / `bad` 返回 null 不自动消失）。每条提示自己计时，鼠标悬停或获得焦点时暂停、移开接着倒数；常驻的带关闭按钮。最多同时 3 条、`aria-live` 与 `role="status"` 不变。
- `components.css`：`.xm-toasts` 仍 `pointer-events: none`，只有 `.xm-toast` 本身接鼠标，不挡页面其它地方。

## 用户

- 登录、卸载这类弹窗转圈时连按 Esc，弹窗不会再凭空消失；以前登录框这样没了以后，再点「登录」也打不开，只能重开软件。

## 开发

- 深查 KB-2（`0.2.24-深查/键盘无障碍.md`）：弹窗忙着时按钮变灰，焦点掉到弹窗外，`Dialog` 自己的 keydown
  收不到 Esc，Chromium 连拦几次 cancel 后就把 `<dialog>` 关了，React 还当它开着。`ui/modal.tsx` 在 document 上补一道
  Esc：只在焦点不在任何 `dialog[open]` 里时、只给最上面那个框，有不是 `Modal` 开的模态框（强制更新层）在时不管；
  `<dialog>` 背着 React 关了就立刻 `showModal()` 回来（祖先被藏起来时不开）。不改字。浏览器测试连按 6 次 Esc 钉住。

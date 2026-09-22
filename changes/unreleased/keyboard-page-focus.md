## 用户

- 只用键盘操作更顺手了：在侧栏或搜索框里换页之后，光标会直接落到新页面的正文，
  按一下 Tab 就能操作页面里的内容，不用再把整条侧栏走一遍；读屏软件会念出「已切换到某某页」。
- 打开软件后按一下 Tab 会出现「跳到正文」，按回车直接跳过侧栏。平时它是隐藏的，不占地方。
- 游戏加速页的线路列表可以用方向键上下挑，按回车或空格选中。

## 开发

- `features/shell/Shell.tsx`：`<main id="v2-main" tabIndex={-1}>` 作为焦点落点；`activePage` 变化后（首次渲染除外）
  下一帧把焦点交给正文区，开着弹窗、或新页面已经自己把焦点放进正文时不抢；`role="status"` 的隐藏播报区念
  「已切换到某页」。侧栏顶部加「跳到正文」链接（不改 hash，只移焦点），样式在 `styles/shell.css`。
- `features/acceleration/AccelerationView.tsx`：线路 listbox 改 roving tabindex，整张列表只占一个 Tab 位；
  方向键/Home/End 只移焦点不改选择（选择会记进本机，#342），回车/空格才选中；行内选线按钮退出 Tab 序列，
  「Ping」按钮照旧可达。纯函数 `lineOptionTarget` 管按键到行号的映射。
- 新增浏览器用例 `features/shell/keyboard.browser-check.mjs`（进 `test:v2:browser` 与夹具挂载预算门禁），
  加速页 `browser-check.mjs` 补一条方向键用例。「跳到正文」原型里没有，差异记入 `docs/UI-V3.1.1-V2-REBUILD.md`。

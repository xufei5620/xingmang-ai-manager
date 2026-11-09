## 开发

- 强制更新那层提示（`RequiredUpdateGate` 的 `GateDialog`）连按三下 Esc 就关掉了，底下必须更新的旧版本照常能用，要重开软件才盖回来（0.2.24 深查 键盘无障碍 KB-1）。原因是 Chromium 只让网页连着拦两次 `<dialog>` 的 cancel，第三次 `cancelable` 为 false。现在在 document 上拦 `keydown` 的 Esc（焦点掉出门外也拦得住，比如门里按钮转圈变灰时），叠在门上的帮助框自己处理的 Esc 不碰；再听 `close`，万一还是被浏览器关了就立刻 `showModal()` 回来。没加字。
- `testing/app-check.mjs` 补一条：焦点在门里、掉到页面上各连按 6 次 Esc 门都在，帮助框照样按 Esc 关，背着程序 `close()` 后门马上回来。旧代码上红、新代码上绿。

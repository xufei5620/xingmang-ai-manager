## 开发

- renderer-v2 其余 17 个文件里手写的防慢响应 `useRef(0)` 计数器全部换成 `useLatestRequest`（#1070 第 8 步下半）：每次发请求先 `begin()`，几件事各自记下当时那一刻、互不作废的用 `capture()`，手动作废的地方换成 `invalidate()`，卸载时作废那行删掉（hook 自己会做）。界面行为不变。`ConfigDialog` 里「打开时自动读型号」的转圈原来拿请求编号当 state，现在改成每次一个新的空对象；`Announcement` 里「正在标已读」的去重原来把编号拼进 key，现在每读一轮换一份名单。剩下的几处 `useRef(0)` 是时间戳、编号、计数或滚动位置，不是竞态守卫，不换。AGENTS.md T6 跟着改：计数器已换完，补上 `capture()` 的用法。

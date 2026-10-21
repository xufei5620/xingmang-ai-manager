## 用户

- 窗口较窄时浮出来的侧栏，点最上面那条空白处也能收回去了。以前要点正文或按 Esc 才收。

## 开发

- `shell.css`：`.sidebar-floating .v2-topbar` 临时 `-webkit-app-region: no-drag`（#1349 第 1 条）。顶栏是拖动区，
  Electron 在 Windows / macOS 上把那里的鼠标按下交给系统拖窗口，页面收不到 `pointerdown`、焦点也不动，
  #1342 的「点外面就收」碰不到它。浮着时第一下只收侧栏、不拖窗口，收回后顶栏照常能拖；系统画的窗口按钮和红黄绿不受拖动区影响。
  `app-check.mjs` 加一条浏览器用例（Windows、Mac 各跑一遍）：浮着时侧栏外面没有一处 `drag`，点顶栏空白处收回，收回和拉宽后顶栏仍是 `drag`。
  无头 Chromium 不认拖动区，真机上点不点得收以真机为准。

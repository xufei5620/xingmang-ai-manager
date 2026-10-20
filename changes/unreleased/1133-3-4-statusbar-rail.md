## 开发

- #1133 第 3 条：状态栏 `.v2-status-user` 加 `min-width: 0; max-width: 220px`（照 v4 原型 `.st-user`）和
  `flex-shrink: 100`（让它先于同样能缩的网络位置让位），里面的 span 省略；按钮带 `title` 和 `data-testid="statusbar-user"`。
- #1133 第 4 条：`@media (max-height: 659px)` 里补 `.sidebar-collapsed` 的规则：图标行 28、分组线上下 4、
  标志行 28、钉住区和账号卡空隙收小。110% 缩放最小窗口（970×566）下 Windows 原来差 36px、Mac 差 68px，
  Mac 在 100% 的最小窗口（1067×622）下原来也差 12px，现在都不滚。`app-fixture.tsx` 加 `?longUsername`，
  `app-check.mjs` 补一条 Windows、Mac 两种外观下的断言。

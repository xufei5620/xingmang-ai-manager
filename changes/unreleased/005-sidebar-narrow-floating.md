## 用户

- 窗口较窄时侧栏也能点开了：侧栏自动收成一条图标时，点左下角的展开键，侧栏会浮在页面上面展开；点外面、按 Esc 或选好一页就自己收回去。以前点了只弹一句「窗口较窄时侧栏会自动收起」，怎么点都展不开。

## 开发

- `Shell`：窄窗口（逻辑宽 ≤ 1271）里点 `sidebar-collapse` 不再只弹「窗口较窄时侧栏会自动收起」，改成 `.sidebar-floating`：侧栏 `position: absolute` 照 224 宽浮在正文上（`--z-drawer`、`--shadow-pop`），网格仍按 60 留列、正文不挪；document 级 `pointerdown`（捕获）点外面、`Escape`（开着 `dialog[open]` 时不管）、再点一次、点 `.v2-nav-item` / `.v2-account-main`、`focusout` 到侧栏外都收回。浮着展开不写 `xingmang-v2-sidebar`、不调 `setSidebarCollapsed`；窗口变宽时清掉，再变窄不自己浮出来。窄的门槛不动。`app-check.mjs` 加两条浏览器用例（按产品负责人截图的约 1092 逻辑宽复现），03 §3 与 ui-spec CHANGELOG 跟着改。

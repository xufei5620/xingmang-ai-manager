## 用户

- Windows 上在「外接工具」页点「自动安装 Python」装好以后，回首页「运行环境」里 Python 那一行就是版本号，不再写「可选 · 未装」、
  不再给安装按钮。以前要在首页点「重新检测」才对。

## 开发

- 第四十三批 F：「外接工具」页（`ExtensionsPage`）的「自动安装 Python」装完只重读本页，首页那份检测结果没动：#871 给「安装卸载」页
  接的 `BusinessActions.onSystemChanged` 这一页没接上。`ExtensionsPage` 收可选的 `onSystemChanged`（缺省 = 只刷新本页），
  `pages-business.tsx` 给 MCP 页转 `actions.onSystemChanged`；装完先叫它、再读本页（同「安装卸载」页）。不新写字。
- 测试：夹具加 `pythonMissing` 和 `installPythonRuntime`（装完下一轮检测就有 3.13.7）；`testing/app-check.mjs` 加一条浏览器回归：
  首页 Python 写「可选 · 未装」，进「外接工具」添加 `python` 启动的连接、点「自动安装 Python」，关掉添加框回首页，那一行是 3.13.7、
  没有安装按钮。去掉 `pages-business.tsx` 传的 `onSystemChanged` 就红。

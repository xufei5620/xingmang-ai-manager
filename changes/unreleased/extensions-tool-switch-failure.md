## 用户

- 外接工具、技能、插件页：在一个工具下装插件、改连接，没跑完就换到别的工具，这时它没做成，「未完成」的提示不会再挂到换过去的那个工具下面，换回原来那个工具就能看到。

## 开发

- `ExtensionsPage`（`src/renderer-v2/pages-management.tsx`）改用页内的 `useToolOperation`：操作结果记着是在哪个工具下点的，只在那个工具下面摆出来，`clear()` 只清屏上那条（#983 顺带发现的另一半，逆向报告 B4）。共用的 `useOperation` 不动。`app-check.mjs` 加一条浏览器用例钉住。

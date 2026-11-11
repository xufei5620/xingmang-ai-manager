## 开发

- `XINGMANG_SIMULATE_MAIN_CRASH=1`（启动 30 秒后主进程抛一次没人接的异常）改为只在开发态认，打包版不再认（D101，
  死代码重复.md H11）。它走的是真的未捕获异常那条路，打包版上演一次就按致命错误报进崩溃统计。写法和同文件的
  `XINGMANG_ONBOARDING_PREVIEW`、`bootstrap/network-routes.ts` 的 `XINGMANG_TOOL_ROUTE_FAST` 一致，都是
  `!app.isPackaged &&`。开发态（`npm run dev` / `npm start`）设了它照样重开一次、第二次不再重开，演法不变。
  `main.test.ts` 钉住这个变量只读一处、读法带打包判断。

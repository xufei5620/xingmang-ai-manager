## 开发

- 修 Windows CI 上 `git-runtime-install.test.ts`「still gives up on each source at the ceiling」偶发红
  （`expected 3800000 to be less than 3640000`）：`electron/slow-download.test-support.ts` 的 `drive()`
  以前最多等 1 万轮事件循环就拨假时钟，Windows 上关文件、删半截文件慢一点，时钟就在代码还在磁盘上时多走几格。
  现在有文件操作在进行的轮次不算数（`process.getActiveResourcesInfo()`），磁盘再慢也不拨；被测代码和断言没动。
  新增 `slow-download.test-support.test.ts` 钉住。同一天 MCP 页「自定义连接」两条点击超时没坐实根因，
  排除过的可能记在 `docs/TEST-BASELINE.md`。

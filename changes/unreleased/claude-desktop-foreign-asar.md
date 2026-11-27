## 开发

- 修 Claude Desktop 放程序（#1932）、放工作区和 Mac 程序（#2033）在正式包里次次跳过（11-27 yoyo 0.2.25 真机，日志
  `claude-desktop.code-seed.skipped` / `workspace-seed.skipped`，`asar-unreadable`，cause `EISDIR`）。星芒自己是 Electron，
  主进程的 `node:fs` 把路径落在 `.asar` 上的一律当压缩包根目录：`open` 报 EISDIR，`stat` 回「文件夹、大小 0」；单元测试跑在
  普通 Node 里测不出来。新模块 `electron/foreign-asar.ts` 的 `openForeignAsar` / `statForeignAsar` 改用 Electron 自带、没被改过的
  `original-fs`（不在 Electron 里时就是 `node:fs`，存储桶同步作业不受影响），`readClaudeCodeBuildPin`、
  `readClaudeDesktopComponentManifest` 打开 app.asar、三个放程序的缓存判断「Claude 换没换版本」时取大小和修改时间都走它。
  新用例 `electron/foreign-asar.test.ts` 在真的 Electron 里（不要图形界面）打一份 Claude 样子的 app.asar，先钉住普通 `fs` 确实
  EISDIR，再钉住两份清单都读得出来；旧代码上同一条用例报的就是客户日志那句。

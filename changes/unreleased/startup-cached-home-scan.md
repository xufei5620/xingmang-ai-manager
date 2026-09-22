## 用户

- 打开软件时首页不用再空着等「正在检测本机工具」：先显示上次检测到的工具列表，同时在后台重新检测，
  检测完自动换成最新的。这段时间里按钮暂时不能点，首页顶上会写「正在检查本机工具，先显示上次的结果」，
  也不会误报「配置被改过」。
- 检测本机工具时不再一下子同时开十来个后台程序，配置低的电脑打开软件时没那么卡了。

## 开发

- 新增 `electron/system-snapshot-cache.ts`：每轮扫描成功后把 `SystemSnapshot` 落到
  `userData/system-snapshot.json`（`safe-local-data` 的 `writeAtomicSafeUtf8File`，读用
  `readSafeUtf8File` 带 512 KB 上限，拒绝硬链接 / reparse）。落盘前去掉 `officialChatGpt` 与
  `network.publicIp`，全部字符串过 `redactCommandText` 并截到 4096 字；快照本身不含 Key（配置那一块
  每次现读）。文件带格式版本与软件版本，任一对不上、结构校验不过都当没有。
- `system:scan` 加一个可选参数 `{ acceptCached: true }`（不新增 IPC 通道）：本次启动还没扫完过一轮时，
  主进程先回上次的结果（带 `cachedAt`），同时确保一轮真扫描在跑；强制重扫、其余调用方（Key 同步、
  开机检查、安装前检查）都不受影响。回旧结果时不更新托盘、不记「检测完成」。
- 渲染层只有 `useToolbox` 开机首屏那一次带这个参数：拿到旧结果先画出来（`loading` 仍为真，按钮照旧
  不可点），在同一个请求号下再读一次真的，接的是主进程开窗前就起好的那一轮。有 `cachedAt` 期间
  `Home` 不判「配置被改过」「已有第三方配置」，App 不发「工具有新版本」通知。`app-check.mjs` 的
  「last saved scan」用例钉住。
- 扫描里起子进程的探测（node、npm、python、git、Codex 桌面端、四家 CLI）经 `BoundedOperationQueue`
  限到同时 3 个（`scanProbeConcurrency`）；网络位置等只发请求的不占名额。

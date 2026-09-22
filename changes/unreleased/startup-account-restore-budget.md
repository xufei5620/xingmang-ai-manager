## 用户

- 已登录的用户开机更快了：以前网络慢的时候，打开软件要先盯着启动画面等十几秒甚至半分钟，
  等登录恢复完才进首页，进了首页工具列表还要再检测一遍。现在启动画面最多等 3 秒，
  断网时直接进；首页先把工具列表画出来，账号那一栏写着「正在恢复登录」，恢复好了自动补上
  余额和账号信息。工具检测也在软件一打开就开始跑，不再等启动画面结束。
- 恢复登录的那几秒里，首页不会误报「配置被改过」或「已有第三方配置」；恢复完会自动
  重新核对一次。

## 开发

- 新增 `electron/account-startup-gate.ts`：启动画面那两条读取（`account:get-session`、
  `config:get`）最多等账号恢复 3 秒，`net.isOnline()` 为假时不等。到点还没恢复完，
  会话答 `{ authenticated: false, restoring: { account } }`（`account` 取自新增的
  `RealmAccountService.restoringAccount()`，本机账号库读出来就知道），配置绕开此时会拒绝工作的
  `accountWork` 门、按未登录读出并带 `ownershipPending: true`。其余作用域通道照旧排在恢复之后。
  恢复没成（没保存账号 / 已失效 / 联不上）时账号没变化、不会有人发会话事件，`main.ts` 在
  预算先到的情况下补发一次。不新增 IPC 通道，只给 `AccountSessionState`、`AppConfigSummary`
  各加一个可选字段。
- 渲染层按「正在恢复的那个账号」算作用域（`account-context.ts` 的 `sessionScope`），恢复成功后
  作用域不变：`AppFrame` 不重挂、`useToolbox` 不清快照，只在会话事件里补读一次配置
  （`refreshConfig`）。恢复中进首页而不是欢迎页；点账号 / 聊天只提示稍等，不弹登录框。
  恢复中收到「未登录」事件按「落回未登录」处理，不当成「登录被结束」清掉工作区。启动那次
  读取若晚于会话事件落地，不再用它盖掉更新的会话（`sessionEvents`）。
- 「配置被改过」判定顺序没动（`tool-config-ownership.ts` 与 `sourceFor`）：主进程侧没有账号可比时
  `ToolConfigOwnershipStore.read` 本来就不会给 `changed`；渲染层 `ownershipAwaitingAccount`
  在 `ownershipPending` 期间把 Key 与当前中转对得上的那一支按连接可用显示，地址指向别处的照常报。
  `Home.test.tsx` 与 `app-check.mjs` 的「slow startup restore」用例钉住。
- `system-service.ts` 的 `scanSystem` 经新顶层纯函数 `createScanCoalescer`：非强制请求接上正在跑的
  一轮，或复用 15 秒内刚跑完的一轮；强制重扫一律新跑；那一轮开始之后安装队列动过（新增
  `InstallationQueue.revision`，每项开始、结束各加一）就不复用。`main.ts` 在账号恢复开始时就起一轮
  预热扫描，首屏读取与恢复后 Key 同步的那次安装检查都直接用它。
- 沙箱（Linux，无 CLI、网络请求打桩为离线）实测：一轮扫描约 210 ms；账号恢复耗时 10 秒时，
  启动画面 10.0 s → 3.0 s，工具列表出现 10.2 s → 3.0 s；恢复 0.5 s 时 0.71 s → 0.50 s。

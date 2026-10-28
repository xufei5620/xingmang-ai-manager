## 用户

- 软件自带的网页内核升级到最新的大版本，付款页和画布都用上最新的安全修复。

## 开发

- G20：Electron 43.8.3 升到 45.1.0（Chromium 156、Node 24.22、V8 15.6）。43 在 2027-01-05 停补丁，45 在 2027-04-27。
  照官方 44、45 两版的破坏性改动清单逐条对过代码，要改的只有剪贴板一处，其余不涉及或已经满足：Mac 13 起（44 不再支持 12，
  `minimumSystemVersion` 早就是 13.0）、Windows 只出 x64（44 不再出 32 位）、三个沙箱预加载脚本编译后只 `require('electron')`
  （45 去掉了沙箱预加载里的 `Buffer`、`setImmediate` 和 `events`/`timers`/`url`）、没有不开沙箱的窗口（45 改了它们 `window.open`
  的进程归属）、权限处理本来就拒绝屏幕共享（45 改报 `display-capture`）、asar 里的随包文件都是 `readFileSync` 整读（45 的 asar
  文件描述符只认 `fs`）、`net.request` 没设 `Sec-Fetch-Dest`、没用 `select-client-certificate` / `isUnityRunning` / `contentTracing`。
- 剪贴板：44 改成跟 W3C 一样的异步接口，`readImage` / `writeImage` 删了，`readText` / `writeText` 返回 Promise。
- `sensitive-clipboard.ts`：写完才落定、写失败抛给调用方（复制密钥、复制新密码两条通道改成 await）；60 秒到点异步读回比对再清。
  新增 `flush()`，主窗口 `prepareToQuit` 里调（`main.ts` 自己建一份经 `IpcRegistrationOptions.sensitiveClipboard` 传进去）：
  沙箱里用 Electron 45 实测，will-quit 里发起的 `readText()` 还没回来进程就退了，原来在 will-quit 里擦剪贴板的那一下改到退出前做；
  `dispose()` 仍撤计时并再试一次。写入还没落定时来的 flush 也认得那段文本（先记下、落定后再挂计时）。
- 新增 `clipboard-image.ts`：图片一律以 `image/png` 进出剪贴板（作品菜单「复制」两处、AI 聊天粘贴截图）。粘贴照旧经
  `nativeImage` 转一遍 PNG，`ChatAttachmentServiceOptions.readClipboardImage` 改成返回 Promise。沙箱里实测写 `image/jpeg`
  读回来也是 `image/png`。
- 复制反馈、启动失败框里的「复制错误信息」改成 await；右键「复制链接」失败记一条 `context-menu.copy-link.failed`，
  不再变成未处理的 Promise 拒绝（那会当成崩溃上报）。
- `platform/system-service.test.ts` 的开机项假数据去掉 44 删掉的 `openAsHidden` / `wasOpenedAsHidden` / `restoreState`。
- 沙箱里用 Electron 45.1.0（Linux、普通用户、xvfb）真开过：electron-ci-smoke、window-close-smoke、onboarding-smoke、
  renderer-v2-native、renderer-v2-native-close-race 都过；画布的沙箱判断照旧成立（默认渲染进程 `Seccomp: 2`，`--no-sandbox` 是 0）；
  `network-failure.ts` 认的两句 Electron 原句（`Attempted to redirect, but redirect policy was 'error'`、`Redirect was cancelled`）
  在 45 的二进制里还在。realm-account-smoke 在 Linux 上走到打开画布那步会被拒，是 Playwright 在 Linux 上总给 Electron 加
  `--no-sandbox`，画布按设计拒绝打开；这个冒烟只在 Windows CI 跑。
- 还欠着、升 46 前要做：`safeStorage` 的同步接口在 45 报弃用、46 删除，各处加密存储要换成异步写法（`docs/RELEASING.md` 记了）。
  45 新带的 Windows 崩溃辅助文件 `electron_wer.dll` 只在调了 `crashReporter.start()` 时才注册，本程序没开（G05），不影响。

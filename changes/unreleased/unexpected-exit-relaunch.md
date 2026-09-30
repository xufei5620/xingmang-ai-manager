## 用户

- 星芒自己意外出错时不再弹一个看不懂的英文框、带着问题接着跑：会先断开加速、还原网络设置，再自动重新打开一次，打开后角落说一句刚才发生了什么，点「复制给客服」就能把错误信息发给客服。10 分钟内再出一次就不再自动重开，免得窗口一闪一闪，下次打开时同样会提示。

## 开发

- 主进程运行期未捕获异常改由 `main.ts` 自己的 `uncaughtException` 监听处理（Electron 自带的监听只在没有别的监听时弹英文 `showErrorBox`，之后进程继续跑）：同步写 `unexpected-exits.log`（`electron/unexpected-exit.ts`，打码同 `redactCrashText`），限时 3 秒等错误报告、`acceleration.stopAll()`、聊天记录和运行日志落盘，再 `app.relaunch()` + `app.exit(1)`；10 分钟内已自动重开过则只退出不重开。重开时按出事前窗口是否可见决定带不带 `--launched-at-login`。
- 下次启动在 `window:get-capabilities` 上多一个可选字段 `unexpectedExit`（无新增 IPC 通道），renderer-v2 角落卡片 `unexpected-exit` 给「复制给客服」（`buildSupportBundle`）并写进帮助框的「最近一次出错」。`RuntimeLogStore` 新增 `idle()`。
- 真机演示：设环境变量 `XINGMANG_SIMULATE_MAIN_CRASH=1` 启动，30 秒后主进程抛一次异常；重开出来的进程带着同一变量会再退一次，正好演「不再重开」。

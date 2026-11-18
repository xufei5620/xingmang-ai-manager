## 开发

- 手机遥控深查 YR-3（yoyo 2026-11-17「改」）：开了「打开星芒时自动打开遥控」的 Mac，遥控开着时也能闲时装更新。
  `CodexRemoteService.idleInstallHold()`（纯函数 `resolveRemoteIdleInstallHold`）分三种：开着又没开自动打开 =
  `'drops'`，照旧这次运行不闲时装（YK-2）；开了自动打开、这一轮在跑、有等你同意的、或者 30 分钟内
  （`remoteIdleInstallQuietMs`）绑定的人发过消息 = `'busy'`，先等；其余可以装，重开后 `startOnLaunch` 自己连回去。
  自动打开开没开留一份在内存（跟 `idleCloseHours` 同一种：连渠道前读盘，之后只有 `setAutoStart` 改）。
  `update-install-prompt.ts` 新增可选的 `remoteControlBusy`：只挡闲时装，不改「人不在就等人回来再跳框」那条，
  框里照旧说闲时会装；读完服务状态文件、真装之前再看一眼遥控，这几秒里手机来了消息就放回去等
  （`install.idle.remote-busy`）。`main.ts` 的「下好了」那句和跳框器改看 `idleInstallHold`，顺手改掉两处
  「重开以后不会自己连回去」的旧注释。不用新字。

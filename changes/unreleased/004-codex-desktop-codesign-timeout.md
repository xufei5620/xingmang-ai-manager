## 用户

- 较慢的 Mac 上 Codex 桌面端不会再一直显示「检测失败」：尤其是英特尔 Mac，以前装好了却一直显示「检测失败」、没法从星芒打开，现在能从星芒正常打开。

## 开发

- 英特尔 Mac 客户报 Codex 桌面端「检测失败：命令执行时间过长，已中止：codesign」：检测时 `codesign --verify --deep` 只给 15 秒，客户机上同一条核对要 22.77 秒（客户用 Codex 自己测的，最后通过）。安装那一步一直给 3 分钟，所以装得上、检测不过；超时会杀掉进程，下次从头再来，点几次「重新检测」都一样。
  `macos-code-signing.ts` 新增 `darwinDeepVerificationTimeoutMs`（3 分钟）和 `darwinGatekeeperAssessmentTimeoutMs`（2 分钟），安装（`macos-desktop-app-installer.ts`）、Codex 桌面端检测（`macos-codex-app.ts`）、外接桌面客户端检测与打开（`external-client-runtime.ts`，原来 spctl 和 WorkBuddy 的深度核对各 20 秒）共用这两个时限。核对的内容一点没变，只是给够时间。
- `macos-codex-app.ts` 同一个应用包（路径加指纹）同时只跑一遍深度核对：首页检测、Codex 型号名单那次检查、打开 Codex 开机时可能同时问到，慢机器上几遍一起跑会互相抢磁盘，一起超时。后来的等先起的那遍，结果一样交给每个人；只记住通过，失败的下次照旧重跑。

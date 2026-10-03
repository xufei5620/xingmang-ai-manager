## 用户

- Windows 上 Codex 桌面端装不上时，错误框开头不再多出一串英文，只显示中文原因。
- 装工具时顺带准备的运行环境没装上，错误框里那句话中间不再夹着一段英文。

## 开发

- `src/renderer-v2/business-common.tsx` 的 `ipcPrefixPattern` 剥 Electron 加在通道名后面的错误类名时，
  不再只认 `…Error` 结尾：主进程 `CodexDesktopInstallFailure` 的类名以前跟着中文原因一起上屏。
  每层只剥一个类名，原话开头的 `ENOENT:`、`TypeError [ERR_*]:` 这类错误码照旧留给错误分类。
- `runtimeStageFailureMessage` 改收原始错误，先过 `rawErrorMessage` 再拼句：以前 `App.tsx` 把
  `cause.message` 拼进句子中间，「Error invoking remote method 'runtime:install-node': Error:」
  留在错误框和「给客服看的原话」里。
- 另两个不以 Error 结尾的类名（`download-retry.ts` 的 `ResumeRefused`、`ai-chat-service.ts` 的
  `StreamFailure`）核过不会作为 IPC 拒绝到达界面，规则放宽后即使到达也会被剥掉。

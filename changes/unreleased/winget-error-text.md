## 用户

- Windows 上缺少系统自带应用安装组件的电脑，首页 Claude Desktop、OpenCode 那两行不再露出英文报错，改成说明这台电脑暂时装不了、可以去官网下载；装 Node.js、Python 和桌面客户端时的进度提示也不再出现英文工具名。

## 开发

- `external-client-runtime.ts`：找不到可信系统 winget 时，`installHint` 固定为 `externalClientWingetUnavailableHint`，原始原因（如 `realpath` 的 ENOENT）经新增的 `onWingetUnavailable` 回调写进运行日志 `external-client.winget-unavailable`，同一原因只记一次；安装进度与失败文案去掉「winget」字样。`node-runtime.ts` / `python-runtime.ts` 切换到官方安装包时的进度文案同理，`failures` 里的原始原因不变。

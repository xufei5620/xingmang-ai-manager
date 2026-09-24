## 用户

- Windows 上缺少系统自带应用安装组件的电脑，首页 Claude Desktop、OpenCode 那两行不再露出英文报错，改成说明这台电脑不能一键安装，原来点不动的「暂不支持」换成「去官网下载」，一点就打开官方下载页；装 Node.js、Python 和桌面客户端时的进度提示也不再出现英文工具名。

## 开发

- `external-client-runtime.ts`：找不到可信系统 winget 时，`installHint` 固定为 `externalClientWingetUnavailableHint`，原始原因（如 `realpath` 的 ENOENT）经新增的 `onWingetUnavailable` 回调写进运行日志 `external-client.winget-unavailable`，同一原因只记一次；安装进度与失败文案去掉「winget」字样。`node-runtime.ts` / `python-runtime.ts` 切换到官方安装包时的进度文案同理，`failures` 里的原始原因不变。
- 新增 `externalClientOfficialDownloadUrls`（`external-client-contract.ts`）与可选状态字段 `officialDownloadUrl`：Windows 上 winget 不可用、又没有腾讯官方包兜底时给出。两条网址逐条并进 `main.ts` 的外链白名单（I12 全等匹配，不放宽规则）；首页 `onOpenExternalDownload` 缺省时仍是「暂不支持」。

## 用户

- C 盘满了也能打开软件：以前磁盘一满、或者杀毒软件拦住设置文件，软件就直接打不开；现在照常打开，只在右下角提示一句「清理一下 C 盘后重开软件就好」。
- 真打不开时的提示改成中文大白话，说清是磁盘满了、被杀毒软件拦住还是安装不完整，不再显示英文原文和电脑用户名；可以一键复制错误信息发给客服，或打开日志文件夹。

## 开发

- `electron/main.ts`：启动时那次设置整理改走 `AppSettingsStore.normalize()`（`app-settings.ts` 新增 `normalizeAppSettings`），磁盘内容已是整理后的样子就不写；写失败只记 `config/settings.normalize.failed`，不再抛到启动兜底。失败种类经 `window:get-capabilities` 的可选字段 `settingsSaveIssue` 交给渲染层，`startup-notice.ts` 的 `settingsSaveNotice` 挂一张角落卡片（第十三批候选 2）。
- 启动兜底弹框从 `showErrorBox` 换成 `showMessageBox`（复制错误信息 / 打开日志文件夹 / 退出）；文案由新模块 `electron/startup-failure.ts` 按 ENOSPC、EACCES/EPERM/EBUSY、MODULE_NOT_FOUND/app.asar、其它四类给出，复制出去的原文先过 `redactHomeDirectory` 与密钥脱敏（I13）。
- `runtime.jsonl` 写不进去本来就不会拖垮软件（`RuntimeLogStore` 写失败只留在内存并在报告里注明），这次没改。

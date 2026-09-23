## 用户

- Codex 的插件页「市场」现在直接列出可以安装的插件，点一下就能装。以前国内网络常常下不来 Codex 的官方插件目录，这一页和 Codex 自己的插件列表都是空的；现在软件会自动替你下载这份目录，下载不下来时会说明原因，并给一个重新下载的按钮。

## 开发

- 新增 `electron/codex-plugin-catalog.ts`：Codex 的官方插件目录由它自己在启动时从 github.com/openai/plugins 同步到 `$CODEX_HOME/.tmp/plugins` + `plugins.sha`（git → GitHub API → chatgpt.com，每条 30 秒），国内常全失败，`codex plugin list` 与 `/plugins` 一直为空。现在快照缺失时由本软件从 codeload.github.com 下载 tar.gz（走 `downloadFetch` 与下载加速，5 分钟超时、压缩 150 MB / 解压 600 MB 上限、只跟同主机跳转），自写的 tar 解析只还原普通文件与目录、路径按敌意输入校验，解到 `.tmp` 下随机目录后一次改名到位；已有完整快照时从不覆盖。沙箱实测 0.155.1 与 0.156.1 用 Key 登录都能列出 `openai-api-curated` 的 49 个插件并装上，装好的插件技能会随请求发给中转。
- `ProviderExtensionService.list('codex')` 带上 `marketplace` 状态，`ensureMarketplace('codex')` 改为下载这份目录（同时发起只下一次，复用已有 IPC 通道）；官方目录里的插件用各自 plugin.json 的显示名与说明补全。
- 插件页 Codex 的「市场」页签改为与 Claude 相同的可装插件列表，目录缺失时进页自动下载一次；自己添加的市场挪到列表下方单独一块。`bounded-response.ts` 新增 `readBoundedResponseBytes`。

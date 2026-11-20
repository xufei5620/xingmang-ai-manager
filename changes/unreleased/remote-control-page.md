## 用户

- 手机遥控挪到左侧栏单独一页，能选手机上用哪个模型。

## 开发

- 「手机遥控 Codex」从设置 › 工具管理的整卡搬成侧栏日常组的 `remote` 页（`CodexRemotePage.tsx`，原 `CodexRemoteCard.tsx` 改名）：连接方式两张可选的小卡（页签）、下面只摆选中那一种的设置、两种共用的设置单独一张卡；去掉 `settingsItems` 的 `codex-remote` 和 `remoteChannelCollapsed`（YF-7 收成一行）。状态栏、首页 Codex 菜单、使用教程、顶部搜索都改去这一页。
- 新通道 `codex-remote:set-model`：手机上单独用的模型（`null` = 跟电脑上一样），入参只收像型号名的字（`isRemoteModel`）。底座在 `thread/start` 和每一轮 `turn/start` 带上；改回跟电脑时用 `config/read` 读出电脑上的型号带回去，因为 `turn/start` 带的型号会一直留在这条对话上。
- 手机上的「帮助」那句、审批卡（「Codex 说：」放在命令前、命令前加「命令原文：」）按产品负责人 2026-11-19 的「改」换字；审批策略没动，还是 `untrusted` + 工作区可写。

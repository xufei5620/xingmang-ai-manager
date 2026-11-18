## 开发

- WorkBuddy 改成客户自己下载（产品负责人 2026-11-18 回「改」「下线」「留着」，新字原文逐字给他看过；并进 #1776 的登录后自动连）：
  首页 WorkBuddy 卡没装时说明「装好 WorkBuddy 后，星芒会自动连上当前账号」、按钮「重新检测」，去掉「去官网下载」、Mac 的
  「安装指南」和外链白名单里的 `https://www.workbuddy.ai/`；教程 Mac 那一章跟着改。旧开机快照里那条下载地址照常读、读出来丢掉。
- 两个版本都认：国内版（`WorkBuddy.exe` / `WorkBuddy.app`，`~/.workbuddy`）和海外版「WorkBuddy AI」（`WorkBuddyAI.exe` /
  `WorkBuddy AI.app`，`~/.workbuddy-ai`），签名主体相同、核对一处没放宽；两个都装着时各写各的 `models.json`，各是一笔事务
  （`ExternalToolPathRoots.workBuddyEditions`）。安装记录在、程序没认的进运行日志 `external-client.candidate-rejected`（按主目录脱敏）。
- 回到星芒窗口时 WorkBuddy 没装就单独看一眼（`external-clients:scan` 新增可选 `{ only: 'workbuddy' }`，没加通道；至少隔 2 分钟、
  复用已核过的签名、失败那次不改首页）。认出来（开机、「重新检测」、回到窗口）且这个账号的密钥写完，就替他自动连一次（D7 的
  `detect`），开着也写；「从没配置过」对 WorkBuddy 改成 `models.json` 里没有星芒站点的模型、星芒没替当前账号写过
  （`ExternalClientOwnershipStore.recorded`，客户删了星芒那条不再加回去）、没用 `WORKBUDDY_CONFIG_DIR` / `WORKBUDDY_DATA_FOLDER_NAME`
  另指配置。自动那次只往文件里追加一条，客户原有的每一条一个字节不动。连好了在角落说配置窗口原有那句，登录那次也说（另两家照旧不说）。
  更新页「## 用户」已满 60 条，这条没占。

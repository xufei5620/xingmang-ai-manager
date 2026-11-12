## 开发

- 外部链接 L4：OpenCode「去官网下载」（Windows 上缺系统 winget 时）的落点从 `https://opencode.ai/download`
  换成 `https://opencode.ai/desktop`。前者现在是 OpenCode 全部产品（桌面、命令行、手机、SDK）的总览页，
  后者只放桌面端各平台安装包。外链白名单经 `externalClientOfficialDownloadUrls` 收录，仍是同一个域名下的
  一条全等网址，条数不变、不加域名。上一版落盘的首页检测结果里带着旧网址的，读回来不认、等这次真的检测
  （`external-client-snapshot-cache.ts` 本来就只认白名单里那一条）。

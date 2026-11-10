## 开发

- Windows 上 Claude Desktop 一键安装没装上时，错误框的出口从「去官网下载」（claude.com/download，国内多半打不开）
  换成「下载离线安装包」（教程站 `guide/manager#offline-packages`，包来自国内存储桶）和「去 Claude 官网」两颗，
  正文点名的按钮跟着改（D64，外部链接.md L5）。新地址 `claudeDesktopOfflinePackagesUrl` 放在
  `claude-desktop-install-failure.ts`，主进程外链白名单按全等匹配收这一条（I12），`main.test.ts` 钉住；
  首页那一行缺系统安装组件时的「去官网下载」不在这次里。

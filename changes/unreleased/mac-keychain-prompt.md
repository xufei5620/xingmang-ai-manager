## 用户

- Mac 上点「重启安装」更新前，会先提醒：重启后可能弹出钥匙串密码框，输入这台 Mac 的开机密码、点「始终允许」就好。教程「备份、更新与数据」里也加了这条说明，搜「钥匙串」能找到。

## 开发

- 自签证书没有 TeamIdentifier，钥匙串按每版程序指纹（cdhash）认人，Mac 每换一个版本第一次读 safeStorage 都会要「登录」钥匙串密码。代码绕不开，只加提示：`pages-maintenance.tsx` 的重启确认框按 `getPlatformCapabilities().platform === 'macos'` 显示 `macKeychainUpdateHint`；`registry/tutorials.ts` 的 safety 章节加一条 extra 与关键词。

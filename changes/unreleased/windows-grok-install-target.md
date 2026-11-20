## 开发

- Windows 普通身份下 Grok 第一次装失败时，失败框「复制路径」复制的是 `C:\ProgramData\XingMangAI\Cli\native\grok`，
  可这时 Grok 实际装进的是个人文件夹下的 `.grok\bin`（`cli-install-service.ts` 的 `sameUserInstall`），客户照着去查写入权限、
  加杀毒白名单都找错地方。`system-scan-service.ts` 的 `resolveCliInstallTarget` 原来在 Windows 上一律报 ProgramData，
  改成跟装的时候一样：只有管理员身份报 ProgramData，普通身份报 `resolveCliUserHomeDirectory`（#1975）给的个人文件夹下的 `.grok\bin`。
  macOS、Linux 上报的位置不变。#1975 那条（D17）做的时候顺带发现的。
- 用例：`electron/system-service.test.ts` 在普通身份和管理员身份下各问一次没装的 Grok 会装到哪，普通身份那半在旧代码上红（报的是托管目录）。

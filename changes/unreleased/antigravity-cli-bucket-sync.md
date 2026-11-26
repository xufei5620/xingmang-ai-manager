## 开发

- Antigravity 接中转第四步，客户端没改：新同步作业 `sync-antigravity-cli-cos`（每 6 小时，也可手动跑），把谷歌签名的
  agy 原件放进存储桶 `xingmang/offline/antigravity-cli/`，一键安装以后先从这里下。同一个作业在 Windows、Mac 机器上
  各跑一次，各写各的清单（`windows.json`、`macos.json`）：Windows 的核 Google LLC 的 Authenticode 签名（钉住
  DigiCert 签发机构）和 PE 头里的芯片，Mac 的解开 tar.gz 核谷歌的 Developer ID 签名（团队 EQHXZ8M8AV）和芯片；
  清单地址必须一字不差、下载按清单的 SHA-512 核，两种芯片版本对不上或比桶里旧时这一轮不发。不可覆盖、完整回读，
  清单留最近 4 版，连续两次定时失败开 issue。写法见 `docs/COS-SYNC.md`「Antigravity 命令行（agy）」。

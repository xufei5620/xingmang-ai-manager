## 开发

- `scripts/sync-chatgpt-official-cos.cjs`：OpenAI 的 Windows 更新清单先换成新版、可下载的 MSIX 还是上一版时（10-17 第 51 次、
  10-24 第 78 次运行，签名照常，十几个小时后 OpenAI 自己换好包），不再报 `package-identity-mismatch`、连着两次开报警 issue。
  包的身份、架构、发布者、签名都对、只是版本比清单旧，桶里这一架构又还有一条 24 小时内核过的上一版时，这一架构算「等包」：
  不入桶、不写清单、不刷 `checkedAt`，作业成功，日志记 `package-pending`，运行页标一条「等官方换包」。超过 24 小时（客户端
  `desktopBucketIndexMaximumAgeMs`，再往后客户端已经不从桶里装了）或桶里没有这一架构时照旧失败，代码是新加的
  `package-version-behind`。`validateWindowsInspection` 把版本挪到签名后面核，旧包签名又坏了时报的是签名。

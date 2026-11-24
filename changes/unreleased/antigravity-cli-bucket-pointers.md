## 开发

- Antigravity 命令行的存储桶同步每次都在最后写清单时失败（#2149）：`scripts/cos-sync-utils.cjs` 只许覆盖写一张固定名单上的清单，
  名单里没有 `xingmang/offline/antigravity-cli/windows.json`、`macos.json`，桶里一直没有清单，客户端只能去谷歌下。
  把这两份加进名单（名单改成 `OVERWRITABLE_POINTER_KEYS`），安装包照旧不可覆盖。`cos-sync-utils.test.cjs` 新加两条用例，
  找出所有带 `overwrite: true` 的同步脚本、用真的名单核它们的清单，以后新加同步作业漏了当场红。

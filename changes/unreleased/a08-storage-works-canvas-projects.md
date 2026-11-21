## 用户

- 设置里「星芒占用的空间」的「AI 作品」把画布项目里生成的作品也算上了，换账号以后数字也不再跟着变。

## 开发

- 「AI 作品」那一行以前只量当前站点的作品文件夹（A08，11-18 复核，0.2.25 总单第 64 项）：画布项目自己选的文件夹没算，
  星芒账号的那一层又套着历史账号的 `realms/api-account`，切到历史账号时合计就变小。现在量两个站点共用的那一层
  （`realm-data-roots.ts` 新增 `sharedAssetOutputDirectory`，是 `assetOutputDirectory` 的反函数），再加上这台电脑上两个站点、
  每个账号的画布项目文件夹里放作品的 `assets`（`canvas-project-store.ts` 新增 `listCanvasProjectAssetDirectories`，
  用 `async-map.ts` 限流读项目记录，不做 `list()` 那套同步的存在检查）。项目文件夹里客户自己的其他文件不算。
- 去重靠 `storage-usage-service.ts` 的 `outermostDirectories`：重复的、被别的套住的（项目文件夹选在作品文件夹里、两个账号
  共用一个文件夹）只算一遍，Windows 上不分大小写。作品文件夹量不出来照旧是「没算出来」；某个项目文件夹量不出来（盘拔了、
  不让读）当没有，日志只记几处没算上，不记路径（I13）。

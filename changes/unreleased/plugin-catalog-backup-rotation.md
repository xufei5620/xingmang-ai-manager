## 用户

- Codex 插件目录坏了反复修也不会再卡住：以前修过三次就再也修不了，还要自己去文件夹里挪东西；现在只留最近一份备份，更早的自动清掉。真清不掉时只提示「重启电脑后再试一次」，旁边有「联系客服」按钮。

## 开发

- `electron/codex-plugin-catalog.ts`：修复前把旧的 `plugins-xingmang-backup-<uuid>` 清到只剩最新一份，修复成功后只留这次刚做的那份；只删完全符合命名格式的目录与单链接版本文件，链接、联接一律不碰（I8）。仍有 3 份以上删不掉时抛 `codexPluginCatalogBackupStuckMessage`，下载前就停，不再把文件夹路径抛给用户。
- 渲染层：`operation-error.ts` 新增 `pluginCatalogStuck` 归类；`ResultNotice` 新增可选 `onSupport`，目录文案里有「找客服」时出「联系客服」按钮，扩展三页接上帮助与客服弹窗。

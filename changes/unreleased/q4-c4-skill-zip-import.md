## 用户

- 技能可以直接从压缩包导入，不用先自己解压；设置的「工具管理」里可以写「给 AI 的长期嘱咐」，Claude Code、Codex、Grok 在每个文件夹里都会照着做。

## 开发

- 总单 Q4 C4：插件页技能「添加」多一项「从压缩包导入」，加一条主窗口通道 `skills:choose-archive`
  （不带参数，主进程弹原生选文件窗口，只收 .zip）。新模块 `electron/skill-archive.ts` 自己读 zip 目录：
  只认存储和 deflate、不认加密 / zip64 / 分卷；压缩包最多 50 MB，解开最多 2000 个文件、50 MB、32 层；
  路径带 `..`、绝对路径、盘符、Windows 不认的名字、Unix 链接和特殊文件、大小写折叠后重名的一律不导；
  每条按目录里写的大小解压、核 CRC。解到数据文件夹下 `skill-archives/〈随机名〉/〈技能文件夹〉`，
  上一次解开的下一次选时删掉；交回的位置再走 `skills:import` / `extensions:mutate` 原来那套检查。

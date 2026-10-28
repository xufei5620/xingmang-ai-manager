## 用户

- 另存图片、视频、音频时如果中途出错（比如磁盘满了、移动硬盘被拔掉），要替换的那个旧文件原样留着，
  也不会多出一个只写了一半的文件。

## 开发

- 作品库三个素材库（`ai-asset-store.ts`、`ai-video-asset-store.ts`、`ai-audio-asset-store.ts`）的 `saveAs`
  从直接 `fs.promises.writeFile` 改成 `writeAtomicSafeBinaryFile`（审查总表 N4，含 H-N4-SUPPLEMENT，Refs #1489）：
  先写同目录临时文件、落盘后改名替换，失败时清掉临时文件，旧文件不动。对话页、视频剪辑、作品库、画布四个
  另存入口都走这三个 `saveAs`，一起修好。权限位显式给 0o644，跟原来 `writeFile` 在常见 umask 下一样，
  不用原子写默认的 0o600。顺带跟其他导出（诊断、反馈、对话、画布项目）一样做了 I8 的检查：保存位置经过
  符号链接或目录联接、目标是硬链接时拒绝（「C 盘搬家」的联接照旧放行）。报错文案沿用原来那三句。

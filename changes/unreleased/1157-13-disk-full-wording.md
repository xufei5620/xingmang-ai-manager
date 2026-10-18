## 开发

- #1157 第 13 条（yoyo 2026-10-18 批「改盘满」）：盘满的三处说法改了。装之前查盘不够时那句（`disk-space.ts` 的
  `describeInsufficientDiskSpace`）在 Windows 上按量到的路径写出盘符：「C 盘空间不足，只剩 300 MB，至少需要 1.0 GB，
  请先清理 C 盘再试」，Mac、Linux 写「磁盘空间不足……请先清理磁盘再试」；以前一律说「安装目录所在磁盘」，量的却是系统临时
  目录和托管目录里最紧的那块，下载的临时文件在系统盘，客户清了安装目录那块盘还是装不上。「磁盘空间不够」一类的说明
  （`registry/errors.ts`）和教程那一步（`registry/tutorials.ts`）改成两处所在的盘都要留空间。
- 带盘符的那句不再含「磁盘」两个字：渲染层 `operation-error.ts` 的 `diskFull` 和两个桌面端的「原样放行」判断
  （`isPlainClaudeDesktopInstallMessage`、`isPlainCodexDesktopInstallMessage`）都加上「X 盘空间不足」，否则 Windows 上
  装 Claude Desktop、Codex 桌面端时会被套成「没装上」。Mac 上装到一半写满的那句（`macosDesktopDiskFullMessage`）没改。

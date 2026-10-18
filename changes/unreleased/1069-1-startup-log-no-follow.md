## 开发

- 启动失败日志写之前不再顺着链接写到别处：`startup-log.ts` 的 `recordStartupFailure` 先 `lstat`，名字不是
  只有一个名字的普通文件（符号链接、联接、多出来的硬链接）就跟超过 128 KB 一样先删掉这个名字，再用
  `O_CREAT|O_EXCL` 新建；已有的普通文件不带 `O_CREAT` 打开，打开后 `fstat` 复核还是 `lstat` 看到的那个文件才写。
  POSIX 另加 `O_NOFOLLOW`，Windows 没有这个标志，靠打开后的复核（和读那一侧 `drainStartupFailures` 原有的
  检查同一套）。`logs` 目录本身被换成联接那半是 Windows 专属，没动（#1069 第 1 条文件层）。

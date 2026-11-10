## 开发

- 导出存不进去时不再借「写不进安装目录」「安装时先下到系统盘的临时文件夹」说（D16，深查「权限和写失败」PW-6）：
  `OperationTarget` 加 `'export'`，EPERM / EACCES 认成 `exportPermission`「这个位置不让星芒存文件，换个文件夹（比如「下载」）再导出。」，
  ENOSPC 认成 `exportDiskFull`「这块盘满了，清出一些空间，或者换一块盘再导出。」。检查页、反馈与客服、设置「导出聊天记录和设置」、
  记录页「导出对话」的页顶红条按失败的是不是导出那一下传 `target`；聊天页红条用 `exportFailureSentence` 接上同样两句，
  认不出的照旧说「这段对话没有导出成功，可以重试」。
- 聊天记录与设置、单段对话导出的保存框默认落在「下载」而不是桌面（`ipc.ts` 的 `desktopDirectory` 改成 `downloadsDirectory`，
  `main.ts` 传 `app.getPath('downloads')`，拿不到时退到主目录下的 Downloads）：Windows「受控文件夹访问」默认保护桌面、不保护下载。
- 原子写最后一步改名被拒时那句「写入被系统占用，请稍后重试」（PW-5）不在这次里，照旧。

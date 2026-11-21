## 开发

- 卸载页（和设置里同一口径的那一项）勾「同时清除登录记录和聊天记录」时，连 `video-projects` 一起清：`chatHistoryDirectoryNames`
  加上它。0.2.24 及以前做过的视频存在 Local Storage 里，勾这一项本来就随它清掉；#2042（三块融合第 1 步，总单 #79）改成一条一个文件
  放进 `video-projects` 以后，这一项就不清它了，换一个人用这台电脑重装还看得见上一个人的分镜。和 Local Storage 一样整个目录删，
  链接、多硬链接照旧拒绝、原样留下（I8）。`uninstall-cleanup.test.ts` 钉住 `main.ts` 里的目录名和清理范围，旧代码上红。

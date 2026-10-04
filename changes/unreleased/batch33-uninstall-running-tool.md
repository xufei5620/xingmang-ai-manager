## 用户

- 卸载工具没成功时，不再只弹「操作没有完成」和一句看不懂的报错：Windows 上工具还开着的，和安装、更新时一样说「工具正在运行」，
  先关掉正在使用这个工具的窗口再重试就行；被权限挡住的说「写不进安装目录」。

## 开发

- 第三十三批 C：`system-service.ts` 的 `uninstallCliOperation` 里 npm 卸载那一步以前不接失败，原样抛 `CommandRunnerError`
  （Windows 上是「命令执行失败（退出码 1）：node.exe」，npm 报的 EPERM / EBUSY 只在 stderr 里），渲染层只能归成「操作没有完成」。
  现在照安装那条路：新增 `describeNpmUninstallFailure` 把 npm 的要点接到原话后面，再经 `describeOccupiedCliFailure` 按这个工具的
  包目录数进程。EBUSY / ETXTBSY，或 EPERM / EACCES 且数到进程，说「{工具} 卸载失败：文件被占用，……」（渲染层归「工具正在运行」）；
  其余说「{工具} 卸载失败：{原话（npm 要点）}」（EPERM 归「写不进安装目录」）。不借 `describeNpmCommandFailure`：它把超时说成
  「下载超时」，卸载不下载东西，借过来会被归成下载超时、叫客户换源重试。
- 卸载失败时 Mac 不数进程：Mac 挪得动、删得掉正开着的程序文件，那边的 EPERM / EACCES 只会是权限不够（比如用 sudo
  装进 `/usr/local` 的那份），数到进程就会叫客户去关窗口，关了照样卸不掉。Mac 上照旧归「写不进安装目录」。
- `cli-process-probe.ts` 的 `action` 加「卸载」；`cli.file-locked` 那条日志按动作说（以前首次安装撞上占用也写「更新时」）。
  卸载抛出的错误把原来的 `CommandRunnerError` 挂成可枚举的 `cause`：运行日志只记可枚举字段，npm 的原始输出照旧进日志。
  卸载前先查工具开没开、错误框加「重试」都要动 `App.tsx`，这次不做。

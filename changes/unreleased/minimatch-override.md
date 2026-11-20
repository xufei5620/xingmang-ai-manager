## 开发

- 构建依赖审计里 minimatch（GHSA-g3hv-75wg-m249）的临时放行删掉（原定北京 11-30 到期，到期后所有 PR 的 audit 作业都会红），
  0.2.25 总单第一档第 3 项、依赖深查 DEP-4。`package.json` 的 overrides 按版本只换两家：app-builder-lib 用的 `minimatch@^10.2.5`、
  @electron/universal 用的 `minimatch@^9.0.3` 都换成 11.0.5；glob 7、@electron/asar、dir-compare 用的 3.1.5 和 filelist 用的 5.1.9
  不在公告范围里，照旧。锁文件多一个 `@isaacs/nonrecursive-glob-match`（minimatch 11 的依赖），少两个旧的 brace-expansion / balanced-match。
- 打包前后比对（同一份编译产物）：Linux、Windows 的目录包逐个文件比 SHA-256，app.asar 里也逐个文件比，唯一的差别是包里 `package.json`
  的 overrides 多了这两行（Windows 的 exe 因为内嵌的 asar 校验值跟着变）。Mac 没在容器里打包：打包规则里没有按平台变的宏，
  拿 app-builder-lib 自己的过滤代码在 darwin / linux / win32 三种设定下、用 10.2.5 和 11.0.5 各跑一遍全部打包规则，选中的文件一个不差；
  Mac 包交给 CI 的三个打包作业。

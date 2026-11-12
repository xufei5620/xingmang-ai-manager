## 开发

- Mac 上从星芒打开工具，交给终端的 PATH 不再整份换成星芒那份：启动脚本保留客户登录 shell 读完
  `~/.zprofile`、`~/.zshrc` 后的 PATH，星芒找程序用的目录（`darwinCommandPathCandidates`）只把还没有的
  补在后面（`macos-platform.ts` 的 `buildMacosAppendedPathLines`）。AI 在工具里跑的 node、python3 和客户
  自己开的终端是同一份，不再先拿到 `/usr/bin/python3`；工具本身照旧按核对过的绝对路径起，#38 的
  `/usr/bin` 在前只管星芒自己找程序（D73，深查 Shell差异 SH-2）。Linux 的打开窗口这次没动：窗口读不到
  客户 `~/.bashrc` 里的 nvm、conda，把代下的 Node 挪后只会换成系统自带的旧版本，等单独拍板。

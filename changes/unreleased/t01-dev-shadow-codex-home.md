## 开发

- 开发用影子 HOME 启动器 `scripts/dev-shadow-home.ps1` 把 `CODEX_HOME` 和 `XINGMANG_CODEX_HOME_OVERRIDE`
  都指到影子目录的 `.codex`，启动前核对程序会挑的三处 Codex 目录都在影子目录里。开发机上继承下来的这两个变量
  指着日常 `~/.codex` 时，dev 版不再改到日常配置（审查总表 T01，0.2.25 总单第 80 项）。
- 同一个脚本：`-Shadow` 给相对路径时按 PowerShell 当前位置变成绝对路径（程序遇到相对路径的开发覆盖变量会拒绝启动）；
  文件改存带 BOM 的 UTF-8，Windows PowerShell 5.1 在英文系统上不再把中文读成弯引号、整份解析失败；
  新增 `-CheckOnly` 只打印要带给 dev 版的环境就退出。Windows CI 的 PowerShell 冒烟
  （`e2e/windows-powershell-probes-smoke.mjs`）用它真跑脚本，拿编译好的 `codex-home` 核对没继承、只继承一个、
  两个都继承和相对路径四种情形。

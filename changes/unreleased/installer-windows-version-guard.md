## 用户

- 在 Windows 7、8、8.1 上运行安装包时，现在一开始就会提示「星芒AI管理工具需要
  Windows 10 或更新的系统」并直接退出，不会再装完了却打不开。ARM 处理器的
  Windows 10 同样会提示需要 Windows 11。

## 开发

- 「可能没想到的问题」第 11 条：`build/installer.nsh` 新增 `customInit`，
  `${IfNot} ${AtLeastWin10}` 时中文提示后 `Quit`；另拦原生 ARM64 且 build < 22000
  （Windows 10 ARM64 仿真不了 x64，我们只出 x64 包）。两处都带 `/SD IDOK`，静默
  安装不挂住。customInit 排在模板的 check64BitAndSetRegView / initMultiUser
  之后，这几步都不写盘，因此被拦时不留任何文件或注册表。
- 32 位 Windows 不动：模板的 check64BitAndSetRegView 本来就带中文提示拒装。
- 新增 `scripts/windows-installer-os-version.test.cjs` 钉住上述两条守卫、
  `/SD IDOK` 与 x64-only 前提，并入 `test:scripts`。

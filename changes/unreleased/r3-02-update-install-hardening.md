## 开发

- 更新安装加固（0.2.25 复查第三轮第 2 条，接审查总表 S01）：`build/update-handoff/verified-install.ps1` 启动安装程序时的运行环境再收紧一项，
  用的位置仍只有管理员能改，装完随暂存目录一起删。
- 用例：`windows-update-handoff.test.ts` 补一条（旧脚本上红）；`e2e/windows-update-handoff-smoke.mjs` 的假安装程序多记两项、多核两项，Windows 打包作业和 `windows-self-upgrade` 真跑。

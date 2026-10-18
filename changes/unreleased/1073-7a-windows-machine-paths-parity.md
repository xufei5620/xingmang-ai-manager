## 开发

- 发版校验自带的那份 Windows 系统目录解析（`scripts/windows-machine-paths.cjs`）和客户端那份
  （`electron/windows-machine-paths.ts`）有了对账测试 `scripts/windows-machine-paths.test.cjs`：同一组加载报告和
  系统设备路径回答喂给两份，SystemRoot、System32、系统 PowerShell 路径和「在不在 System32 里」的判断都要一样。
  两份实现都没改。唯一对不上的是核心模块路径里带 NUL 的边角（实际碰不到），记在 #1225，测试里那条先标 todo
  （#1073 第 7 条 a）。

## 开发

- Windows 系统目录（SystemRoot）解析只留一份：`electron/windows-system-root.ts`。客户端
  `electron/windows-machine-paths.ts` 照常 import；发版校验 `scripts/windows-machine-paths.cjs` 要在没编译主程序时也能跑，
  第一次查 SystemRoot 时用 TypeScript 从源码现转这一份，只许它引用 `node:` 内置模块（无签名模式和非 Windows 不会读它）。
  唯一的行为差别以客户端为准：核心模块路径里带 NUL 时，发版脚本以前改问系统设备路径，现在和客户端一样直接拒绝（实际碰不到）。
  客户端在 480 种输入组合下的结果一字不差，发版脚本除 NUL 那 30 组外也一字不差；客户端的结果已钉成绝对值，
  对照测试那条 todo 已去掉（#1225）。

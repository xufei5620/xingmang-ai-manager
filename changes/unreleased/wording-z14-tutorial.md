## 开发

- 改字批次 Z14（教程）：W1b、W17、W55、W85、D76。`registry/tutorials.ts`、`TutorialIllustration.tsx`
  里的「工具箱」换成「星芒」（「星芒工具箱」收成「星芒」）；教程和提示里的 Command + Q 换成 ⌘Q
  （`locale-status.ts`、`electron/running-tools.ts`，`window-lifecycle.ts`、`main.ts` 的注释同步）；
  教程里星芒自己界面上的路径「→」换成「›」，Windows / Mac 系统设置、Codex 自己的窗口、终端、
  浏览器和安装包那几段照旧用「→」；「从首页「打开」中选「重启 Codex」」改「重开 Codex」，
  教程里另两处「重启 Codex」和「提示 Codex 已在运行？」跟着 W15 的新名字改成「重开 Codex」
  「Codex 桌面端还开着」；「访问密钥」照 W85 改「密钥」（教程那一步的标题、示意图里的字段名和
  说明一起改）；「命令行工具里报错」加一条 WSL 说明（D76，Linux 版教程里去掉）。
  `startup-notice.ts` 那句 Command + Q 归 Z11，没动。

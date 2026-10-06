## 用户

- Mac 新手引导里，Node.js 没准备好时运行环境那一行不再叫你去应用外面装，按钮改叫「一键安装」：Node.js 本来就是星芒自己准备的。
  选工具那一步，命令行工具下面也改说「会自动帮你准备运行环境」。

## 开发

- 已知9：`StartGuide.tsx` 的 `runtimeByApp` 原来只算 Windows 和能代装 Node.js 的 Linux，Mac 照旧写「在应用外安装完成后回来
  重新检测」、按钮叫「安装指南」，选工具那一步写「命令行，要先按提示准备运行环境」。可 Mac 第十六批 2 起也由本软件准备 Node.js，
  按钮点下去其实是星芒自己去下。现在 Mac 和 Linux 一样按 `runtimeAutoPrepare` 判断，Windows 不变；用的都是 Windows、Linux
  那边现成的字，不加新字。`StartGuide.test.tsx` 里原来钉着「Mac 字样不动」的两条改成 Linux、Mac 一起测。

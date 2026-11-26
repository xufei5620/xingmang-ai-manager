## 用户

- Mac 上从星芒打开的 Antigravity 桌面端现以简体中文显示界面。

## 开发

- Antigravity 桌面端中文界面（yoyo 2026-11-26 亲手打「反重力调试口同意」「反重力默认中文」，深度）：
  随包带上开源插件 yuhuan-dev/antigravity-usage-monitor v1.5.6 的简体中文词表（`bundled-catalog/antigravity-zh-CN/`，
  GPL-3.0，原样不改，许可原文和来源同目录，也进了第三方许可清单），加星芒自己写的换字脚本
  （`electron/antigravity-desktop-chinese.ts`），只改界面文字和提示文字，客户和 AI 写的内容、代码、终端、图标字体不碰。
  插件本身不装、代码不用：它的更新不核签名、会改快捷方式和注册表，2026-11-26 读码评估过。
- Mac 上星芒起 Antigravity 时加 `--remote-debugging-port=<本机空口>`，用 lsof 核对口上在听的全是刚起的进程、只听本机，
  再经浏览器级 CDP 连接往它自己的界面页面挂新文档脚本并换当前页（`electron/antigravity-desktop-cdp.ts`）。连接一直挂着，
  刷新和新窗口接着换；没换成照旧英文、只记日志，不加界面文字。Windows 上经资源管理器打开带不上参数，这一半没接。

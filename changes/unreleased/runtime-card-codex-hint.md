## 用户

- 只用 Codex 桌面端、没装命令行工具的电脑，首页「运行环境」里 Node.js 不再标橙点写「未安装」，改成和 Python、Git
  一样的「可选 · 未装」；讲 Claude Code 缺 Git 的那段只在装了 Claude Code 时才出，管理员授权那段改成灰字说明。
- 首页「运行环境」里管理员授权那句不再说「点『安装』后」，改说「准备 Node.js 时」，不会再跟工具列表里的「安装」搞混。
- Windows 上用中文界面打开 Codex 桌面端，窗口出来以后那一行改说「Codex 桌面端已经打开，正在把它的界面换成中文」，
  不再叫你去开始菜单找它。

## 开发

- 第二十七批 B：`src/renderer-v2/features/tools/Home.tsx` 运行环境卡按「有没有在用的命令行工具」决定 Node.js 那行
  是不是可选。装了、正在装（装工具时会顺带准备 Node.js，那时要看见弹授权窗口那句）、这次没查出来装没装（A4）都算在用；
  Codex 桌面端不算。一个都不在用时 Node.js 行和 Python、Git 一样灰点「可选 · 未装」，Windows 管理员授权那段、
  Mac/Linux「还没有 Node.js」那段用 `.v2-runtime-hint.is-quiet` 灰字。`home-runtime-git-hint` 只在 Claude Code
  在用时出（插件市场、技能和插件里的命令都是 Claude Code 的事），按钮都不变。
- `elevation-notice.ts` 新增 `homeNodeElevationNotice` 给首页用：在用时说「准备 Node.js 时」会弹窗（首页按钮叫
  「准备 Node.js」，装工具时顺带准备的那次客户点的是工具行的「安装」），不在用时先说一般不用单独点。
  「安装卸载」页的 `elevatedInstallNotice` 不变，那里的按钮就叫「安装」。
- 第二十七批 D：`electron/codex-desktop-service.ts` 打开 Codex 桌面端的等待阶段加 `switching-language`：找到 Codex
  进程、开始换中文（等调试端口、核对端口归属）之前切过去，心跳那句改成「Codex 桌面端已经打开，正在把它的界面换成中文，
  已经等了 N 秒。」，不再满 20 秒就加「可以先去开始菜单看看」。只有 Windows、选了中文界面时走到。

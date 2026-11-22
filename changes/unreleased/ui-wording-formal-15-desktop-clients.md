## 开发

- 界面文案正式化第十五批（主进程第五批，逐条对照在 `/mnt/project-files/界面文案正式化/清单.md` 第十九节「第 15 批」）：Codex 桌面端、外部客户端和插件一带的提示和报错改成书面口吻。
- Codex 桌面端的打开、安装、更新、重置（`codex-desktop-service.ts`、`codex-desktop-install-failure.ts`、`codex-desktop-known-issues.ts`、`codex-desktop-cdp.ts`、`provider-launch-service.ts`、`macos-codex-app.ts`）：
  例如「Codex 桌面端没有打开：等了将近一分钟，没有等到它的窗口」→「Codex 桌面端未能打开：等待近一分钟，窗口仍未出现」。
  装不上那句的开头「Codex 桌面端没装上」改成「Codex 桌面端未能安装」，Claude Desktop 那句同样改成「Claude Desktop 未能安装」：
  没用「安装失败」，因为装之前查盘那句的开头就是「Codex 桌面端安装失败：」「Claude Desktop 安装失败：」，界面按开头认这一类，撞上会把磁盘不足认成装不上。
- 外部客户端（`external-client-*.ts`、`claude-desktop-*.ts`）：「已经有配置了或者正开着，这次没有自动连接」→「已有配置或正在运行，本次未自动连接」。
- 插件、MCP、技能（`provider-extensions.ts`、`codex-extensions.ts`）：「没法确定这个技能装在哪里」→「无法确定该技能的安装位置」。
- 复查第二轮第 14 条：「工作目录」在这批的改成「项目文件夹」（`windows-elevation.ts`、`ipc/parsers/`、`workspace-access.ts` 等），记住的文件夹没了那句界面新旧都认；
  第 10 条：「Codex 命令行版」统一叫「Codex CLI」（产品负责人 2026-11-22 回「命令行版改」），报错框按钮「改用 Codex CLI」和 `operation-error.ts` 按按钮名找动作的那处一起换。
- 下载与校验的原话、错误 detail 和只进运行日志的几句、Gemini 专用的几句不改。新字不含错误目录的标题原文；165 条逐条比过，`classifyOperationError` 对新旧说法给出的分类一致。
  断言旧字的用例跟着换成新字；已知打不开那一版的提示不许出现技术词的那条用例，放行了「Codex CLI」这个名字，其余 CLI 字样照旧不许出现。没有跳过用例。

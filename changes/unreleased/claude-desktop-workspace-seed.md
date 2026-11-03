## 开发

- Claude Desktop 的 Cowork 工作区和 Mac 上的 Claude Code 程序改由星芒从自家下载站放好（yoyo 11-03「如果能用这个方式就不要加速了」）。
  清单从客户自己装的那份 Claude 的 `app.asar` 里读（`electron/claude-desktop-component-manifest.ts`：工作区那段对象字面量
  `versions:[{sha,files:{unix,win32}…}]` 只取最新一版，Claude Code 那份 JSON 取 `darwin-*` 的 `bundle` 和 `linux-*`），
  只认纯数据字面量，深度、节点数、长度都设顶，读不出就什么都不放。
- 工作区（`claude-desktop-workspace-seed.ts`）：只在 Claude 已经留下 `.cowork-adopted`、工作区又没好时，
  从桶里下官网原样的 `<文件>.zst`，按清单的大小和 SHA-256 核过，临时名写入后改成 Claude 认的 `<文件>.zst`，
  最后写 `.<文件>.zst.origin`（Claude 离线预放的格式，它自己解压、按 rawChecksum 再核）。从星芒打开 Claude 时看一次、
  之后十来分钟里再看几次，后台下、不挡打开；盘不够（压缩包加解开的大小）不下；同一版工作区一台电脑 7 天内只送一次、
  下坏了 30 分钟内不再试；远程开关 `claude-desktop-workspace-seed` 关了就停，正在下的那个文件下完不再下下一个。
  Cowork 虚拟机里的 Linux 版 Claude Code 从 npm 国内镜像放（`claude-desktop-vm-code-seed.ts`，按 npm 官方源 SHA-512 对账）。
- Mac 程序（`claude-desktop-mac-code-seed.ts`）：打开 Claude 前从桶里下 `claude.app.tar.zst`，核 SHA-256，
  自写 tar 解析只收 `claude.app/` 下的普通文件和目录（拒链接、设备、`..`、重名，256 项、1GB 封顶），
  核 Mach-O 头的芯片，临时目录里解好再改名到 `claude-code/<版本>/<校验值前12位>/`，最后写 `.verified`。
  Claude 开着或中途被打开就不动；远程开关沿用 `claude-desktop-code-seed`。
- 新同步 `sync-claude-components-cos`（`scripts/sync-claude-components-cos.cjs`）：每 6 小时下最新的 Windows x64 安装包，
  解出 `app.asar`，用编译好的客户端模块读清单、算桶里的位置，缺的才从 `downloads.claude.ai` 的两个固定目录下，
  大小和 SHA-256 对上清单才传进 `xingmang/offline/claude-components/`（不可覆盖、完整回读）。五部分各一台 Ubuntu 机器，
  连续两次定时失败开 issue 报警。`electron/claude-desktop-components-sync.test.ts` 钉住同步传的位置就是客户端去取的位置。

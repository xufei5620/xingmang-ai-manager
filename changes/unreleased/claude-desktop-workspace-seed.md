## 开发

- Claude Desktop 的 Cowork 工作区和 Mac 上的 Claude Code 程序改由星芒从自家下载站放好（yoyo 11-03「如果能用这个方式
  就不要加速了」，11-20 远程客户电脑上 Claude Desktop 发不出消息、横幅连不上 downloads.claude.ai 后排第一）。桶在 #1934
  已同步好，这里接上客户端。清单从客户自己装的那份 Claude 的 `app.asar` 里读（`claude-desktop-component-manifest.ts`），
  桶里的位置跟同步作业用同一份 `claude-desktop-component-keys.ts`。
- 工作区（`electron/claude-desktop-workspace-seed.ts`）：工作区没好时从桶里下官网原样的 `<文件>.zst`，按清单的大小和
  SHA-256 核过，临时名写入后改成 Claude 认的 `<文件>.zst`，最后写 `.<文件>.zst.origin`（Claude 离线预放的格式，它自己解压、
  按 rawChecksum 再核）。装好就下，不等 Claude 写 `.cowork-adopted`（yoyo 11-20「这个下载不能在安装的时候一次性下载好嘛」，
  回「工作区改」）：星芒装好或更新好 Claude Desktop、开机（检测跑完再等 30 秒，`seedClaudeDesktopWorkspace`）、从星芒点
  「打开」三处都叫，后台下、不挡打开；同时叫的共用一次。每台约 1.3 GB，不用 Cowork 的电脑也下。盘不够（压缩包加解开的
  大小）不下；同一版工作区一台电脑 7 天内只送一次、下坏了 30 分钟内不再试；Windows 上只在同用户执行模式下做
  （`trusted-only` 跳过，同 #1932）。新远程开关 `claude-desktop-workspace-seed`，关了就停，正在下的那个文件下完不再下下一个。
- Cowork 虚拟机里的 Linux 版 Claude Code 从 npm 国内镜像放（`claude-desktop-vm-code-seed.ts`，按 npm 官方源 SHA-512
  对账，放在 `claude-code-vm/<版本>/claude`，没有校验值那一层）。
- Mac 程序（`claude-desktop-mac-code-seed.ts`）：打开 Claude 前从桶里下 `claude.app.tar.zst`，核 SHA-256，
  自写 tar 解析只收 `claude.app/` 下的普通文件和目录（拒链接、设备、`..`、重名，256 项、1GB 封顶），
  核 Mach-O 头的芯片，临时目录里解好再改名到 `claude-code/<版本>/<校验值前12位>/`，最后写 `.verified`。
  Claude 开着或中途被打开就不动；远程开关沿用 `claude-desktop-code-seed`；下载进度跟 Windows 一样显示在工具行上。
  `external-client-runtime.ts` 的打开前准备从只有 Windows 放开到 Mac。
- `desktop-package-bucket.ts` 的 `validateDesktopBucketUrl` 放行 `xingmang/offline/claude-components/`（同步脚本写的
  目录，路径形状由两个 key 函数钉死，I10）；写盘走 `safe-local-data`（I8），日志路径过 `redactHomeDirectory`（I13）。
- Claude Desktop 配置框顶上那句 Windows、Mac 都换成「程序和工作区星芒都替它放好」那句（yoyo 11-20 回「工作区改」）；
  更新说明那条是 yoyo 11-20 定的原话。

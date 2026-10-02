## 用户

- Mac 上 OpenCode 桌面端可以在首页一键安装了：工具箱下载官方安装包，确认是官方原版后放进「应用程序」。
  没装成时提示里多一个「看安装指南」，照教程自己下载安装。

## 开发

- 新增 `electron/macos-desktop-app-installer.ts`：Mac 上外部桌面客户端的一键安装，目前只收录 OpenCode。
  官方 feed（GitHub Releases 的 latest.json）只取版本号，包地址按版本号自己拼，并要求 feed 里写的正好是它；
  每一跳重定向都限定在 `github.com/anomalyco/opencode/releases/` 与 GitHub 的两个附件域名（同 `git-runtime-install.ts`，I10）。
  下载走 `downloadWithResume`（断点续传、体积上限），解压用 SIP 下的 `/usr/bin/tar` 到产品目录里的私有暂存，
  再核对：只有一个 `OpenCode.app`、bundle id、`LSMinimumSystemVersion` 对 `sw_vers`、`codesign --verify --strict --deep`
  钉死 Developer ID 团队 `5NZ4Q7NXJ4` 与 bundle id（按退出码判定）、`spctl --assess`（公证）。全过才 `rename` 进
  `/Applications`（不可写时 `~/Applications`），跨卷时 `ditto` 到隐藏的临时名再改名，上次拷到一半被打断留下的隐藏副本
  下次安装前清掉；同名应用一律不覆盖。不加隔离属性：Gatekeeper 首次打开要做的判定 `spctl` 已经做过。
  不钉哈希：这些应用自己会升级，签名才是跨版本不变的身份。
- `electron/external-client-runtime.ts`：Mac 上 `installSupported` 只对上面那张表里的客户端、且非 root 时为真；
  安装前先查磁盘空间，下载包在临时加速线路里（`system-service.ts` 传入 `downloadFetch` /
  `withDownloadAcceleration` / `assertInstallDiskSpace`）。WorkBuddy、Claude Desktop 和 Codex 桌面端在 Mac 上不变，
  仍是「安装指南」：沙箱里拿不到能核对的官方 Mac 包。
- 失败文案集中在 `electron/macos-desktop-install-failure.ts`（零依赖，主进程拼、渲染层认）；
  `operation-error.ts` 新增 `macDesktopInstallFailed` / `macDesktopTooOld` 两类和「看安装指南」按钮，
  排在网络规则前面。装到一半写满磁盘（ENOSPC，或 tar / ditto 报 No space left on device）照直说磁盘空间不足，
  归「磁盘空间不够」；解不开的包报「没装好」，不说成不是官方原版。错误类名以 `Error` 结尾
  （`MacosDesktopInstallError`），渲染层剥 IPC 前缀时才会连类名一起剥掉。
  教程「Mac 上装桌面端」一章改成 OpenCode 一键、其余三个照旧自己下载。

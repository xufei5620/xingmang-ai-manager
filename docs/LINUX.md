# Linux 版

星芒AI管理工具本身的 Linux 桌面版（带界面，和 Windows、Mac 版并列），装在客户自己的 Linux 电脑上用。不是服务器命令行版。

**现在的状态（2026-10-02）**：能打出 `.deb`，CI 每次都在 x64 和 arm64 的原生机器上真装一遍、以普通用户真开一次；发版流程（publish-release）也能出 Linux 发布包了，但**开关默认关着，还没对客户发布**（第 4 节）。Grok 一键装、终端启动等还没做完（下面「还欠着的」）。本地出包（第 2 节）只出本地测试包，更新器关着；发布包只走 `npm run release:package:linux`（无签名发布模式），`electron-builder.config.cjs` 的 `beforePack` 拒绝 Linux 用两种签名发布模式出包。

## 1. 已定的做法

| 事项 | 定法 | 理由 |
|---|---|---|
| 安装包格式 | 只出 `.deb`，x64 与 arm64 各一份 | Ubuntu 22.04/24.04、Debian 12、统信 UOS、deepin、银河麒麟都认 deb。AppImage 在 Ubuntu 23.10+ 上起不来沙箱、还要另装 FUSE，而且挂载点在程序退出后就没了，Claude Code 的钩子脚本会指向不存在的路径；snap / flatpak 会圈住 `$HOME` 和终端启动；rpm 暂不做。龙芯、MIPS 不支持（Electron 没有这两种 CPU 的官方构建）。 |
| 安装目录 | `/opt/xingmang-ai-manager`，命令 `/usr/bin/xingmang-ai-manager`（update-alternatives），应用菜单里仍叫「星芒AI管理工具」 | electron-builder 用 productName 当 `/opt` 下的目录名，中文目录名会让一堆脚本和终端出问题。productName 不能按平台分，所以由打包标记 `XINGMANG_LINUX_PACKAGE=1` 换成英文名，见第 2 节。 |
| 沙箱 | 安装脚本**无条件**把 `chrome-sandbox` 设成 `root:root 4755`，和 Google Chrome 的 deb 一样；保留上游的 Ubuntu 24.04 AppArmor 配置 | 上游模板用 `unshare --user true` 判断要不要 setuid，但 postinst 以 root 跑，root 几乎总能建用户命名空间，于是判断成「不需要」，客户以普通用户打开时既没有命名空间可用、也没有 setuid 兜底，程序直接起不来。Chromium 能用命名空间沙箱时仍优先用它，setuid 只是后备。**任何地方都不许出现 `--no-sandbox`**：画布窗口的隔离（AGENTS.md I15）靠的就是它。 |
| 完整性 | 靠 `/opt` 下全归 root、只有 root 能写 | Linux 没有代码签名，ASAR 完整性那根 fuse 在 Linux 二进制里什么也不嵌（`e2e/asar-tamper-smoke.mjs` 因此只在 Windows 跑）。 |
| 依赖 | Depends 补上 electron-builder 默认漏掉的 `libsecret-1-0`、`libgbm1`、`libxkbcommon0`、`libudev1` 等；Ubuntu 24.04 改名带 `t64` 的几个写成「新名 \| 旧名」；Recommends 中文字体与系统密码库 | 缺一个动态库是首次启动就报错，不是安装时报错。只写旧名在 24.04 上靠 Provides 也能装，只写新名会让 22.04 和 Debian 12 装不上。 |
| 运行身份 | 安装时系统要一次开机密码；软件运行时从不提权，也不许以 root 运行 | root 下 Electron 必须关沙箱才能启动。 |
| 数据目录 | `${XDG_DATA_HOME:-~/.local/share}/XingMangAI`，只在 `managed-cli-paths.ts` 的 `linuxProductRoot` 定；Node.js 在 `Runtime/node`，Claude / Codex / Gemini 在 `Cli/npm` | 原来的 `/var/lib/xingmang-ai` 普通用户建不出来；XDG 是 Linux 桌面的惯例。 |
| Node.js | 软件自己下官方压缩包（`linux-node-runtime.ts`）：版本钉在 v24.21.0，x64 / arm64 各钉一个 SHA-256，字节可以从 npmmirror 来但哈希必须对上；只用 root 所有、别人不可写的 `/usr/bin/tar`（退到 `/bin/tar`），环境只给 `PATH=/usr/bin:/bin` 和 `LC_ALL=C`。安装和启动 CLI 时这份排在继承的 PATH 前面（`linux-platform.ts`） | Ubuntu、Debian 自带的那份常常太旧，排在后面永远轮不到它；不提权、不碰系统包管理器。`trustedCommandEnvironment` 的 Linux PATH 仍把它放最后，那份环境在 Linux 上只给辅助进程用（执行模式恒为 same-user）。 |

| 托盘 | 启动时问一次会话总线有没有人占着 `org.kde.StatusNotifierWatcher`（`linux-tray-host.ts`，固定路径的 `/usr/bin/dbus-send`，退到 `/usr/bin/gdbus`，1.5 秒超时）。有才建托盘；没有就不建，关窗直接退出，设置页「点关闭按钮时」那一行说明原因，开机自启时直接弹窗 | 原版 GNOME（Debian 12、Fedora，以及关掉 AppIndicator 扩展的 Ubuntu）没有接收方，`new Tray()` 照样成功、图标却哪儿都看不见，关窗「缩到托盘」后窗口就找不回来了。只认 StatusNotifier，只支持老式 XEmbed 的面板也按没有算 |
| 开机自启 | 写 `${XDG_CONFIG_HOME:-~/.config}/autostart/xingmang-ai-manager.desktop`（`linux-autostart.ts`），Exec 带 `--launched-at-login`；关掉开关就删掉。读写走 safe-local-data（I8）；用户在系统里停用了（`Hidden=true` / `X-GNOME-Autostart-enabled=false`）或文件指向别的程序时报「登记了但没生效」，不替他改回来 | Electron 在 Linux 上没有登录项接口（`getLoginItemSettings` 恒为 false），各家桌面认的是 XDG 这个约定 |
| 菜单与窗口图标 | 不要应用菜单（`Menu.setApplicationMenu(null)`，按 Alt 也不弹英文菜单）；窗口图标用 `assets/brand/v3/app-icon.png` | Linux 上 Electron 默认菜单是英文的 File / Edit / View；`.ico` Linux 不认 |
| 中文输入法 | Wayland 会话（Ubuntu 22.04/24.04 默认）启动前加 `--enable-wayland-ime --wayland-text-input-version=3`（`linux-ime.ts`），命令行上已有的不重复加；X11 会话不加 | 不加的话 Wayland 下输入框收不到输入法（沙箱里用嵌套 weston 实测：两个开关都加才建出 text-input 对象）。真机上各输入法框架的表现还没验 |
| 加速 | 平台能力 `acceleration: false`：侧栏、搜索、托盘菜单、设置里的加速提醒都不出现，也不发加速相关请求 | 计划里第一版不带加速（⑫） |
| 桌面端与外部客户端 | Codex 桌面端那一行在维护页不显示，首页外部客户端（Claude Desktop 等）一行都不列，教程里删掉讲桌面端的章节和句子 | 这几个都没有 Linux 版 |
| 新手引导与教程 | Linux 上新手引导默认推荐 Codex CLI；教程第一章换成 Codex CLI，更新那一步写「点『安装新版本』→ 星芒关掉 → 系统安装窗口里点『安装』、输开机密码 → 从应用菜单重新打开」；安装、配置、打开、加速和两章 Mac 专属教程不显示（`registry/tutorials.ts` 的 `tutorialTopicsFor`） | Windows / Mac 拿到的教程不变（测试钉住） |
| 可选环境 | Git、Python 缺了时直接给 `sudo apt install -y git` / `sudo apt install -y python3`，写在首页卡片和检查页里，不放「去官网」按钮 | 只出 deb，装 deb 的系统都有 apt；官网给的是 Windows / Mac 安装包 |
| 客服信息 | 读 `/etc/os-release`（`linux-os-release.ts`，过滤成只剩系统名字、最长 48 个字符）：检查页「操作系统」写「Ubuntu 24.04.1 LTS（64 位）」，「复制给客服」写「Linux（Ubuntu 24.04.1 LTS · 64 位）」，启动日志另记桌面（GNOME / KDE…）、x11 还是 wayland、有没有托盘 | `os.release()` 在 Linux 上只是内核版本号，客服分不出是哪个发行版 |

后面各 PR 的默认做法（数据目录、托管 Node、无密码库登录、自动更新走系统安装器、画布要求沙箱、第一版不带加速、版本号与 Windows/Mac 一致）见项目文件 `Linux版/计划与拆分.md`，落地时各自补进本文件。

## 2. 本地出包

只能在 Linux 上出（fpm 和 dpkg-deb 都在 Linux 上跑）：

```bash
npm run build:linux      # 类型检查 + 测试 + 编译，然后出 x64 和 arm64 两个 deb
npm run build:linux:ci   # 只编译，出本机架构的一个 deb（CI 用，检查由别的作业跑过）
```

两条都带 `XINGMANG_LINUX_PACKAGE=1 XINGMANG_LOCAL_BUILD=1`。不带标记直接 `electron-builder --linux` 会被 `beforePack` 拒绝（否则装到 `/opt/星芒AI管理工具`）；标记也不许出现在 Windows / macOS 构建里（会把产品名换掉），`run-macos-free-build.cjs` 交给 electron-builder 的环境里会把它剔掉。

出完包校验：

```bash
node scripts/verify-packaged-hardening.cjs release/linux-unpacked   # arm64 是 release/linux-arm64-unpacked
node scripts/verify-linux-deb.cjs release --arch x64
```

`verify-linux-deb.cjs` 查的是：控制字段（包名、版本、架构、依赖）、包内每个文件都归 root 且组和其他用户不可写、没有包外的链接和多余的安装位置、包里不带 setuid 位（只由 postinst 按名字设一个）、postinst 无条件设 chrome-sandbox 且不再用 `unshare` 探测、菜单文件的 Exec / StartupWMClass / `xingmang://` 登记、主程序与 chrome-sandbox 的 ELF 架构和包标的一致、`package-type` 是 deb、包内 `package.json` 有 desktopName 且更新器关着，最后核对同目录下这个架构的更新清单（`latest-linux.yml` / `latest-linux-arm64.yml`）与 deb 的大小和 SHA-512 一致。加 `--release` 是查发布包：更新器开着、标了 `xingmangUnsignedRelease`、`resources/app-update.yml` 指向这个版本的正式更新目录且不带 `publisherName`。

真装真开（必须以普通用户、在有显示的环境里）：

```bash
sudo apt-get install ./release/xingmang-ai-manager_<版本>_amd64.deb
xvfb-run -a node e2e/linux-deb-smoke.mjs /usr/bin/xingmang-ai-manager
```

冒烟先从磁盘上读装好的目录（全归 root、只有 root 能写、chrome-sandbox 是 4755），再起程序等首页加载，最后从 `/proc` 读：没有进程带关沙箱参数，每个渲染进程的 `Seccomp` 都是 2（只有 Chromium 沙箱会装 seccomp-bpf）。

云端开发容器以 root 运行，要先建一个普通用户再起：`useradd -m smoke`，然后 `runuser -u smoke -- env PATH=<node 所在目录>:/usr/bin:/bin HOME=/home/smoke xvfb-run -a node e2e/linux-deb-smoke.mjs`。

## 3. CI

- `quality.yml` 的 `linux-package`（进 quality-gate）：x64 在 `ubuntu-24.04`、arm64 在 `ubuntu-24.04-arm`，各自打包 → 两道产物校验 → apt 真装 → 打开 Ubuntu 24.04 的用户命名空间限制 → 普通用户真开一次（上面的冒烟）→ 再跑一遍 `packaged-hardening-smoke.mjs`（迁移只做一次、拒绝远程调试参数）→ 卸载并确认 `/opt`、`/usr/bin`、菜单文件、AppArmor 配置一样不留。typecheck 与 npm test 由 `linux-test` 跑，这里不重复。
- `package-for-testing.yml` 选 `linux`：先在 x64 上跑一遍 typecheck 和 npm test，再两个架构各自出包、校验、真装真开，过了才上传。artifact 名字带 `NO-AUTO-UPDATE`，装上以后只能手动换新版。选 `both` 仍只出 Windows 和 macOS。
- `publish-release.yml` 的 Linux 那半见第 4 节。

## 4. 发版

Linux 和 Windows / Mac 用同一个版本号、同一次 publish-release。

- **出包**：`platforms` 选 `all`（默认）或 `linux` 时跑两个作业（选老的 `both` 仍只有 Windows 与 macOS）。`linux-checks` 在 x64 上把 typecheck、npm test、test:v2、test:canvas、test:ui 跑一遍；`linux-build` 在 `ubuntu-24.04` 和 `ubuntu-24.04-arm` 上各跑一次 `npm run release:package:linux -- --arch <x64|arm64>`（线上这个架构的清单比本次旧 → 编译 → 出无签名发布模式的 deb → 加固校验 → `verify-linux-deb.cjs --release`），再 apt 真装、普通用户真开、卸干净，过了才上传 artifact `linux-release-<架构>-<版本>`。和 Windows 门禁相比少的三项（测试改由 linux-checks 跑、开发目录冒烟、ASAR 篡改校验）每次都会打印原因，见 `scripts/run-linux-release-package.cjs`。两个作业不读 secret、不挂 release 环境，不会多一次批准。
- **更新目录**：每个架构一份清单，x64 是 `latest-linux.yml`、arm64 是 `latest-linux-arm64.yml`（electron-updater 按 `process.arch` 找），各只列自己那个 deb，没有 blockmap。文件名统一从 `scripts/linux-artifact-names.cjs` 来；清单名单是 `update-release-utils.cjs` 的 `UPDATE_MANIFESTS`，发布护栏、清单备份、回滚、发布后复核、service-status 的最低版本检查都按它认。
- **开关**：仓库变量 `XINGMANG_PUBLISH_LINUX`（GitHub 比较时不分大小写）。不是 `true`（包括没建，现在就是没建）时，publish 作业不下载 Linux 的包，更新目录和 GitHub Release 里都不会出现 Linux 的东西；Linux 两个作业红了也不挡 Windows / Mac，只选 `linux` 时 publish 作业整个跳过。包照样出，在那次运行的 artifact 里留 14 天，可以下下来装机验收。是 `true` 时 Linux 和别的平台一样：这次选了 Linux 而 Linux 作业没成功（失败或超时）就不发，两个架构的清单必须一起到，发布后 `update:verify-feed --platform=linux` 把两个架构都下载核一遍，GitHub Release 挂两个 deb（应用里「打开下载页」去的就是那里）。
- **打开开关**（第一次对外发 Linux 版之前要 yoyo 点头、真机过一遍）：仓库 Settings → Secrets and variables → Actions → Variables → New repository variable，Name `XINGMANG_PUBLISH_LINUX`，Value `true`。已经发过 Windows / Mac 的版本，可以在同一个 commit 上再触发一次、选 `linux` 补发（线上没有 Linux 清单算第一次发布，护栏放行）。关掉就删掉变量或改成别的值。
- **回滚与服务状态**：rollback-release 和 service-status 都读 Linux 两份清单，线上没有就跳过。Linux 最早只能退回到它第一次对外发的那一版，再早的版本没有 Linux 备份，回滚会对 Linux 报警告、保持不动（`docs/SERVICE-STATUS.md`）。服务状态的最低版本不许高于线上任何平台（含 Linux）正在发的版本。
- **dl.solov.cc 下载落地页没动**：它不在发版流程里，是 `npm run dl:publish` 经 SSH 手动部署到服务器的静态页，三个按钮都指向飞书安装教程。对外发 Linux 时要在飞书教程里加 Linux 的安装说明和 GitHub Release 上 deb 的下载方式，落地页如需单独的 Linux 按钮再改 `dl-landing/` 并重新部署，这两件都要产品所有者来做或批准。

## 5. 还欠着的

| 编号 | 内容 |
|---|---|
| ② | 已做（#761）：Linux 上 Node.js 由软件自己装、Claude / Codex / Gemini 一键装 |
| ③ | Grok 在 Linux 一键装；Gemini 不再要求 Python |
| ④ | 客户自己的终端里能直接敲命令 |
| ⑤ | 一键打开终端运行工具 |
| ⑥ | 没有系统密码库也能登录（不记住，绝不明文） |
| ⑦ | Linux 安全边界：路径信任、环境变量收紧、拒绝 root、画布沙箱检查、日志脱敏 |
| ⑧ | Linux 自动更新（交给系统安装器，不用 electron-updater 的 DebUpdater） |
| ⑨ | 已接上发版流水线、更新目录、回滚 / 服务状态（第 4 节，开关默认关）；还欠 dl.solov.cc 落地页和飞书教程里的 Linux 下载说明 |
| ⑩ | 已做：托盘、开机自启、菜单、窗口图标、中文输入法、加速页与桌面端行隐藏、教程文案、客服信息带发行版（第 1 节）。没做：标题栏在各家桌面上的样子、Wayland 下从托盘图标打开窗口能不能到最前面（推测有的桌面不行），都要真机看；应用内卸载和卸载后清 CLI 配置里的钩子路径另做 |
| ⑪ | 软件自己联网也认系统里装的公司证书 |
| ⑫ | Linux 加速 |

**真机还没验过**：Ubuntu 24.04 桌面上 AppArmor 配置真的装上并生效、arm64 真机、统信 UOS / 银河麒麟（推测可能默认拦未签名的 deb，要真机确认）。第一次对外发 Linux 版之前必须真机过一遍，并由 yoyo 批准。

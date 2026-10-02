# Linux 版

星芒AI管理工具本身的 Linux 桌面版（带界面，和 Windows、Mac 版并列），装在客户自己的 Linux 电脑上用。不是服务器命令行版。

**现在的状态（2026-10-02）**：能打出 `.deb`，CI 每次都在 x64 和 arm64 的原生机器上真装一遍、以普通用户真开一次。但**还没对客户发布**：Grok 一键装、终端启动、无密码库登录、Linux 安全边界、自动更新、发版流水线都还没做（下面「还欠着的」）。所以现在的 Linux 包只出本地构建模式（`XINGMANG_LOCAL_BUILD=1`，更新器关着），`electron-builder.config.cjs` 的 `beforePack` 拒绝任何 Linux 发布模式构建。

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

`verify-linux-deb.cjs` 查的是：控制字段（包名、版本、架构、依赖）、包内每个文件都归 root 且组和其他用户不可写、没有包外的链接和多余的安装位置、包里不带 setuid 位（只由 postinst 按名字设一个）、postinst 无条件设 chrome-sandbox 且不再用 `unshare` 探测、菜单文件的 Exec / StartupWMClass / `xingmang://` 登记、主程序与 chrome-sandbox 的 ELF 架构和包标的一致、`package-type` 是 deb、包内 `package.json` 有 desktopName 且更新器关着。

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

## 4. 还欠着的

| 编号 | 内容 |
|---|---|
| ② | 已做（#761）：Linux 上 Node.js 由软件自己装、Claude / Codex / Gemini 一键装 |
| ③ | Grok 在 Linux 一键装；Gemini 不再要求 Python |
| ④ | 客户自己的终端里能直接敲命令 |
| ⑤ | 一键打开终端运行工具 |
| ⑥ | 没有系统密码库也能登录（不记住，绝不明文） |
| ⑦ | Linux 安全边界：路径信任、环境变量收紧、拒绝 root、画布沙箱检查、日志脱敏 |
| ⑧ | Linux 自动更新（交给系统安装器，不用 electron-updater 的 DebUpdater） |
| ⑨ | 发版流水线、更新目录、回滚 / 服务状态、下载页加 Linux；做完才拆掉 `beforePack` 里的发布模式拦截 |
| ⑩ | 托盘、开机自启、输入法、加速页隐藏、文案 |
| ⑪ | 软件自己联网也认系统里装的公司证书 |
| ⑫ | Linux 加速 |

**真机还没验过**：Ubuntu 24.04 桌面上 AppArmor 配置真的装上并生效、arm64 真机、统信 UOS / 银河麒麟（推测可能默认拦未签名的 deb，要真机确认）。第一次对外发 Linux 版之前必须真机过一遍，并由 yoyo 批准。

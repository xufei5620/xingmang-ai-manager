---
paths:
  - "electron/linux-*.ts"
  - "electron/platform-capabilities.ts"
---

# Linux 安全边界

> 这是按路径加载的规则：只有改到上面列出的文件时才进入上下文。和 `macos-platform.md` 对照着读。

**Linux 问的是 macOS 那个问题，不是 Windows 的。** 本程序在 Linux 上从不提权，并且拒绝以 root 运行（`linux-launch-guard.ts`），所以问题是「**除 root 与当前用户之外**的主体能否改动它解析后的目标」，答案在 `electron/linux-path-trust.ts`。每个既不是 win32 也不是 darwin 的平台都按 Linux 处理，和 `platform-capabilities.ts` 的分法一致。

| 函数 | Linux 上的语义 |
|---|---|
| `isUserWritablePath` | `isLinuxForeignWritablePath` |
| `isTrustedHighIntegrityExecutable` | 绝对路径 + 上面那条 |
| `trustedCommandEnvironment` | 重建 PATH：托管 npm bin、`/usr/local/sbin`、`/usr/local/bin`、`/usr/sbin`、`/usr/bin`、`/sbin`、`/bin` 在前，继承项在后，托管 Node 最后，**每一项过同一判定**；另剥一批只在 Linux 生效的注入变量（glibc 的不安全变量表、`LD_*`、`BASH_FUNC_*`、`SHELLOPTS`/`PS4`、GTK/GIO/GStreamer/gdk-pixbuf/Qt 模块路径、`LUA_*` 等） |
| `runCommand` 的 `trustedOnly` | **Linux 已补可信解析**：可执行文件只从可信 PATH 找，realpath 后再判，spawn 规范路径但 argv[0] 保留查找时的名字（`/bin/sh` 指向 dash、Ubuntu 的 uutils coreutils 这类一体式程序靠它分辨自己是谁）；参数里的绝对路径（单独一项或 `--x=/...`）和 `trustedPaths` 同判。macOS 那条欠账仍在 |
| relocated-folders | `acceptsLinuxRelocationTarget`，不再借用 macOS 规则 |
| `commandEnvironment`（same-user） | `linux-platform.ts` 的 `linuxCommandPathCandidates`：托管 Node、托管 npm bin 排在继承 PATH **前面**，和上面 trusted 那份相反，是有意的：Ubuntu、Debian 自带的 Node.js 常常太旧，排在后面永远轮不到托管那份。Linux 的执行模式恒为 same-user，安装和启动 CLI 都走这份，trusted 那份只给辅助进程用 |

⚠️ **和 macOS 不同、最容易照搬错的两点**：

1. **组可写目录按实际成员判，不按固定 gid。** macOS 信任 gid 0 和 80；这两个数字在 Linux 上没有意义，而 Ubuntu / Debian / UOS 桌面默认「用户私有组 + umask 002」，用户自己的 `~/.local` 就是 0775、组是自己。所以规则是：能以这个组身份写的所有账号（`/etc/group` 里列出的成员 + `/etc/passwd` 里以它为主组的账号）都只是 root 或当前用户，才可信。用户私有组可信；Debian 老系统 `root:staff 2775` 的 `/usr/local` 在 staff 没人时可信；sudo 组里只有当前用户时可信，有别人就不可信（不把 sudo/wheel 当「等价 root」，因为读不到 sudoers）。gid 0 直接可信。两个账号文件连同 `/`、`/etc` 必须 root 所有且非组/他人可写；读不到、有 NIS 兼容行（`+`/`-`）、gid 不在文件里（LDAP/SSSD）一律不可信。
2. **词法链和解析后的链都要走。** PATH 项按字面路径查找，所以放在 `/tmp` 里、今天恰好指向 `/usr/bin` 的符号链接也不可信。路径里带 `.` / `..` 段直接拒绝。macOS 只走解析后的链，这是有意的差别。

和 macOS 相同的两点：名字说的是「外部主体可达」，不是 `access(W_OK)`；这**不是同 uid 防御**。

**刻意不做**：不读 POSIX ACL / xattr（同 macOS 的热路径理由）；判定不跨调用缓存，账号文件只在遇到非 0 gid 的组可写目录时才读。

**已知残余**：LDAP/SSSD 给某个本地 gid 追加的成员从文件里看不见。

## 拒绝以 root 运行

`linux-launch-guard.ts`：euid 为 0，或 `SUDO_UID` / `PKEXEC_UID` 指向别的账号，就拒绝。`platform/entry.ts` 最先判，弹一次中文提示就退出，不拿单实例锁、不读设置、不写日志。退出前把 `HOME`、`XDG_*`、userData 指到私有临时目录并关掉硬件加速，否则 `sudo -E` 时 Chromium 的配置、显卡着色器缓存会以 root 身份写进客户主目录（实测会写）。不要做「Linux 管理员模式」，也不要自动 chown。

## 画布必须有系统沙箱（I15）

`linux-renderer-sandbox.ts`。打开画布前先看启动开关：`no-sandbox`、`disable-seccomp-filter-sandbox`、`disable-gpu-sandbox`、`single-process`、`no-zygote`，或环境变量 `ELECTRON_DISABLE_SANDBOX`（有就算，值是 0 也算），任一存在就拒绝；再起一个和画布同样隔离设置（`canvas-window.ts` 的 `canvasRendererIsolation`）的隐藏渲染进程，读 `/proc/<pid>/status`，要求 `Seccomp: 2`。只缓存通过的结论。

实测（Electron 43.6.0、内核 6.18、普通用户）：默认是 2；`--no-sandbox`、`ELECTRON_DISABLE_SANDBOX=1`、`--disable-seccomp-filter-sandbox` 都是 0，其中最后一个开关检查看不出来，只能靠读进程。显卡驱动有问题时用 `--disable-gpu`，不要用 `--disable-gpu-sandbox`。

## 日志脱敏（I13）

`redactHomeDirectory` 在 Linux 上把主目录记作 `~`、按路径边界匹配（主目录 `/home/al` 不会把 `/home/alice` 截成半个名字），并去掉 `/home/<名>`、`/media/<名>`、`/run/media/<名>`、`/run/user/<uid>`、gvfs 挂载名里的 `user=`。Windows 和 macOS 的输出不变。

## 包的完整性

electron-builder 在 Linux 上不嵌入 ASAR 完整性数据，fuse 打开也挡不住改包（打包摸底实测）。Linux 上 `extraMetadata` 里那几个开关只靠安装目录归 root 所有来保护，这也是只出装到 `/opt` 的 deb、不出 AppImage 的原因之一。

## 打开工具的命令窗口（I1）

`linux-terminal.ts`。交给命令窗口程序的参数只有常量和 `/bin/sh <启动脚本>`，用户能影响的东西（工具路径、续聊参数、项目文件夹、Gemini Key）全在脚本正文里、逐个按 POSIX 单引号转义：Debian 的 x-terminal-emulator 包装脚本在 `-e` 后只有一个参数时会走 `sh -c`，`/proc/<pid>/cmdline` 对谁都可读。启动脚本路径限定为不用转义的字符，三种只收一个字符串的终端（tilix、lxterminal、qterminal）才能照空格切对。找终端只看 PATH 里的绝对路径项和系统目录、启动绝对路径（相对项会在项目文件夹里找，等于让仓库自带一个 `gnome-terminal`）；不读 `$TERMINAL` 这类变量。脚本先放 `$XDG_RUNTIME_DIR`（本人所有、0700、不是链接才用），否则系统临时目录（本人私有，或 root 所有且带粘滞位），不放项目文件夹。不要为了「一个窗口一个进程」去加 `--disable-server` 这类开关：脚本自己 `cd`、自己 export / unset 那几个关键变量，交给后台进程的终端也拿不到错的文件夹和账号。

## 仍然欠着的

- 统信开发者模式、麒麟 KySec 这类发行版执行管控还没处理，要真机。
- 卸载后 CLI 配置里残留的钩子路径还没有应用内清理流程；deb 的 root 卸载脚本**不许**去遍历用户主目录（I8 的 root 版）。
- 托管 Node.js 的来源校验、自动更新不走 electron-updater 的 deb 安装，各由对应的改动负责，不在这几个函数里。

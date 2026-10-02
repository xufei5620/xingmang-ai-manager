## 开发

- Linux 版拆分 ②：Linux 上 Node.js 改由本软件准备（`platform-capabilities.ts` 的 `nodeRuntimeInstall` 改为 `managed`，
  `ui-spec/08-platform-matrix.md` 同步，Mac 那格一并改成第十六批 2 以来的实际做法）。新模块
  `electron/linux-node-runtime.ts`：版本钉在 v24.21.0，x64 / arm64 各钉一个 SHA-256（取自 nodejs.org 的
  SHASUMS256.txt.asc，已用 nodejs/release-keys 验过签名），字节可以从 npmmirror 来；只用属主为 root、
  组和其他人不可写的 `/usr/bin/tar`（退到 `/bin/tar`），环境里只给 `PATH=/usr/bin:/bin` 和 `LC_ALL=C`（`TAR_OPTIONS`、`GZIP` 带不进去），`--no-same-owner` 解压，
  核对目录结构并跑一次 `node --version` 后原子替换。
- 数据目录（摸底 G1/G2）：非 Windows、非 macOS 平台的产品根目录从 `/var/lib/xingmang-ai` 改为
  `${XDG_DATA_HOME:-~/.local/share}/XingMangAI`（`managed-cli-paths.ts`），`ensureManagedNpmLayout` 不再拒绝 Linux。
- 托管 npm（G3）：Linux 上 Claude Code、Codex CLI、Gemini CLI 和 macOS 一样先装进 npm 缓存里的暂存前缀，
  核对后整体换进托管前缀，不再写用户 `~/.npmrc` 指的全局目录；包目录按 POSIX 的 `lib/node_modules` 找
  （`system-service.ts`、`cli-process-probe.ts`）。Grok 不在这次范围（拆分 ③）。
- 找程序的顺序（G4）：新模块 `electron/linux-platform.ts`，本软件准备的 Node.js 排在继承的 PATH 前面
  （和 macOS 相反：Ubuntu、Debian 自带的那份常常太旧，排在后面永远轮不到它），随后是托管 npm 的 bin，
  再是 Volta、fnm、`~/.npm-global` 这类常见用户目录和系统目录。`trustedCommandEnvironment` 没动。
- 失效的本机代理（G9 并入加速那条）：Linux 上 npm 子进程和启动 CLI 时也绕开指向本机、但已经没人监听的
  代理变量（`withoutDeadLoopbackProxies`）；Windows 原样，macOS 仍不绕。
- 「换成新版 Node.js」在 Linux 上也提供（`shouldReplaceNodeForCertificates`、渲染层 `canReplaceNode`）。
- 渲染层：首页缺 Node.js 时 Linux 也显示「准备 Node.js」那句说明，不再送去 nodejs.org、不再提包管理器；
  新手引导里 Linux 的运行环境字样按能力判断（`runtimeAutoPrepare`），Windows、Mac 的字样不变。
- 测试：`linux-node-runtime.test.ts`（含一次用系统 tar 解真压缩包）、`linux-platform.test.ts`，以及
  `managed-cli`、`command-runner`、`system-service`（Linux 托管 npm 安装两例）、`platform-capabilities`、
  `node-replace`、`runtime-install-guide`、`StartGuide`、`Home` 里的 Linux 用例；Linux 专属的用
  `it.runIf(process.platform === 'linux')` 门控。`command-runner` 两条原本「非 darwin 都跑」的 Windows PATH
  断言改成只在 win32 跑；`cli-revert` 的夹具改成装进托管目录；模拟 Linux 安装的 `certificate-trust`、
  `install-cancel`、`download-acceleration` 用例会在 HOME 下建托管目录，Windows 主机上的 HOME 不是 POSIX
  路径，改为只在 macOS / Linux 主机上跑（`disk-space` 原本就这样门控），并清掉 `XDG_DATA_HOME`；
  `download-acceleration` 原来那条「Windows 以外不绕代理」拆成 Linux 绕、macOS 不绕两条；两条模拟 macOS
  原生 Claude Code 的用例不再读宿主机自己的全局 npm；legacy 的 `platform-presentation.test.ts` 改为显式给
  一份 external 能力（只动测试，跟着平台能力契约走）。

## 开发

- Linux 版拆分 ③（摸底 G6）：Grok CLI 在 Linux 上也能一键装。`grokInstallStrategyFor('linux')` 新增
  `linux-official-npm`，和 macOS 一样在临时目录里 `npm ci`：先不跑脚本、整张依赖图对上官方 SHA-512，
  再跑 xAI 自己的 postinstall，把程序解到 `~/.grok/bin/grok-<版本>`。Linux 没有 codesign，新模块
  `electron/linux-grok.ts` 改为核对：这个文件（按链接选中时的 dev/ino 打开）必须和锁里校验过的
  `@xai-official/grok-linux-x64` / `-arm64` 那份 `grok.br` 解出来逐字节一致、归当前用户且只有一个链接，
  `--version` 报的正是这次的版本；不过就把 `grok`、`agent` 两个链接退回原样（复用 `macos-grok.ts` 的快照与回滚）。
  `~/.grok/bin/grok` 已经是这种布局描述不了的链接（xAI 自己的安装器、手做的）时，出错时没法原样放回，
  所以在 npm 跑之前就停下，并用一句中文说清楚。`platformCapabilitiesFor` 里 Grok 在所有平台都是 `managed`。
- Linux 的 Grok 有没有新版只问 npm，不问 x.ai（新增 `cliLatestVersionSource`；`buildUncheckedLatestVersion`
  加可选的平台参数，不给时和以前一样答 `official-manifest`），Windows、macOS 仍以 xAI stable 为准、为上限。
  已装版本从 `~/.grok/bin/grok` 指向的文件名读（npm 的 postinstall 不写 `version.json`）。
- Linux 的 Grok 卸载：只认「相对链接直指同目录 `grok-<版本>`」这种布局，链接用已核对的逐文件卸载删，
  再一个一个删 `grok-<版本>` 程序文件；删不掉的（多个链接、不归当前用户）照 macOS 的口径回
  `manual-required` 并给一条 `rm -f`。`~/.grok` 里的设置和会话不动。
- Linux 版拆分 ③（摸底 G8）：Gemini 在 Linux 上不再先要 Python。`PlatformCapabilities` 加可选的
  `cliNeedsPythonRuntime`（缺省 = 按渲染层注册表判断，旧行为），Linux 上 Gemini 为 false；`planCliInstall`
  与新手引导（`pythonNotNeeded`）都按它走。首页缺 Python 时 Linux 只说一句四家都用不到、给
  `sudo apt install python3`，不再给 python.org 按钮和 Mac 的教程章节。Windows、macOS 不变，有测试钉住。
- 测试：新增 `linux-grok.test.ts`（真 brotli 夹具：通过、改过的字节、链接指错版本、平台包缺失/版本不对、
  `--version` 不对、硬链接、不支持的芯片、回滚、卸载与拒绝陌生布局），`system-service.test.ts` 加一组
  「Linux Grok install from npm」（装、装后核对失败回滚、装完再卸）和策略、版本来源、目标目录的用例，
  `platform-capabilities`、`runtime-readiness`、`runtime-install-guide`、`StartGuide`、`Home` 补对应用例；
  Linux 专属的用 `runIf` 门控。另在云沙箱（x64）里用真的 `@xai-official/grok@1.0.44` 跑过一次 postinstall、核对和卸载，
  并在完全没有 Python 的 PATH 下装过 `@google/gemini-cli@0.60.0`、`gemini --version` 正常；arm64 没实测。
- 文档：`docs/LINUX.md` 第 1 节补「Grok」「Python」两行、第 5 节把 ③ 标为已做；`.claude/rules/linux-platform.md`
  补 Grok 的完整性一节；`docs/MODULE-MAP.md` 加 `linux-grok.ts`；`ui-spec/08-platform-matrix.md` 的 Linux 运行环境格补一句。

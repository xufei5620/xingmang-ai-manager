## 用户

- Mac 上别处装的 Codex CLI、Grok CLI 星芒打不开时，首页会写明原因，并给一颗「用星芒装一份」；xAI 新版安装脚本装的 Grok CLI、别的软件替你装的 OpenAI 原版 Codex CLI，现在也认得出、能正常打开。

## 开发

- Mac 验收 R1：Mac 上命令行里找到的 Codex / Grok 不是 npm 装的、又核不出是官方安装器那一份时（布局对不上、
  签名不是 OpenAI / xAI 的、报的版本和目录写的不一致），以前首页照样给「打开」、点了只说没打开成。现在
  `tool-installation.ts` 把这几种归成 `UnrecognizedDarwinCliError`（中文一句，原因留在 `cause`），扫描时
  `ToolStatus.unrecognizedInstall` 带给首页，卡上写「不是星芒装的，星芒没法替你打开」、主按钮换成
  「用星芒装一份」（走安装），切账号的来源牌、「重新安装」和外部来源那句提示不出。抄盘、起进程这类说明不了来路的失败不算，照旧按原样报。
- Codex、Grok 签名或版本没过的那几处改抛 `DarwinCliProvenanceError`（`macos-code-signing.ts`），好跟 I/O 失败分开；判定本身一条没放宽。
- 认不出的 Codex 不再被「不会另装一份」拦（`cli-install-service.ts` 的 `assertNpmChannelOwnsCli`）：星芒的 npm 目录在
  `darwinCommandPathCandidates` 里排在前面，装好以后找到、打开的都是星芒那份。Grok 装之前先看 `~/.grok/bin/grok`：
  被手做的绝对链接或普通文件占着、npm 的安装脚本盖掉就放不回去的，一个字节都不下就停，说清楚先用原来的方式卸载。
- xAI 官方安装脚本现在（核对时 stable 是 1.0.89）把程序放成不带版本号的 `~/.grok/downloads/grok-macos-<arch>`，`grok` 和 `agent`
  两条链接都指向它。`macos-grok.ts` 认这种布局：版本不再从文件名读，改成核过 xAI 签名的私有副本跑一次 `--version`，
  按文件身份缓存（最多 8 条，文件一变就重核）；带版本号的老布局照旧不跑程序。这种布局的卸载不在这次范围内，仍按原来的拒绝走。
- OpenAI 同一个版本里还发 provisioned 包（`codex-provisioned-package-<target>.tar.gz`，同一份 SHA256SUMS 里）：`bin/codex` 换成一段
  固定的 sh 启动脚本，本体挪进带描述文件的 `CodexCLI.app`。测试机上那份就是它，只是被别的工具解到了
  `~/.local/share/openchatcut-codex/<版本>`。`macos-codex.ts` 现在认它：启动脚本只核和 OpenAI 原文一字不差、从不运行；
  整个 `CodexCLI.app` 抄进私有目录（`darwin-cli-staging.ts` 的 `bundleRoot`，本体带受限 entitlements，单抄本体起不来），
  按 OpenAI 团队号加签名标识 `codex` 核签名，再跑一次 `--version` 对上 `codex-package.json` 的版本。放在官方安装器目录以外的
  只认这一种包，来源显示「其他来源」，不给「移到废纸篓」的卸载命令。

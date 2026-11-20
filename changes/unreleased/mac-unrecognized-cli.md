## 用户

- Mac 上别处装的 Codex CLI、Grok CLI 星芒打不开时，首页会写明原因，并给一颗「用星芒装一份」；xAI 新版安装脚本装的 Grok CLI 现在也认得出、能正常打开。

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
- 测试机那份 Codex 其实是 OpenAI 同一版本里另发的 provisioned 包（`bin/codex` 是固定的 sh 启动脚本，本体在
  `CodexCLI.app`），被别的软件解到了 `~/.local/share/openchatcut-codex/<版本>`。yoyo 11-20 定不放宽「只认官方安装文件夹」
  这条位置限制，这种照旧按认不出处理、首页给「用星芒装一份」，别再当缺陷去认它。

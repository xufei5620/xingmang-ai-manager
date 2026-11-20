## 用户

- Mac 上用星芒更新 Grok CLI 或装回旧版以后，它附带的 agent 命令也换到同一版，不再停在第一次装的那一版。

## 开发

- 0.2.25 总单第 39 项（11-18 复核 D19）：Mac、Linux 上星芒装 Grok 走 npm，xAI 的 postinstall 只改 `~/.grok/bin/grok`，
  `agent` 靠 `macos-grok.ts` 的 `ensureDarwinGrokAgentLink` 补；它以前只补「没有」，已经有的一概不动，所以每次更新、
  装回旧版以后 `agent` 都还指着第一次装的那一版。现在 `agent` 是一条指向官方那几种布局（downloads 下带或不带版本号的
  macOS 程序、npm 放在旁边的 `grok-<版本>`）、又跟 `grok` 不一样的链接时，先建临时链接再 rename，原子地换成跟 `grok`
  一样的目标；普通文件、指到别处的手做链接照旧不动。
- 回滚跟着改：快照从「在不在」（`captureDarwinGrokAgentLinkPresence`）换成 `captureDarwinGrokAgentLink`，记下原来的目标；
  安装后核对没过时 `restoreDarwinGrokAgentLink` 把 `agent` 挪回原来那一版，不会出现 `grok` 退回旧版、`agent` 留在没核过的新版上。
- Mac 首页扫描本来就每次调一遍这个 ensure（internal #20），所以以前更新过、`agent` 已经指歪的 Mac，升到这一版后下一次扫描就自己对上。
- 用例：`electron/linux-grok.test.ts` 新增更新后 `agent` 跟到新版、核对失败退回旧版、手做链接不动三条（Linux 上跑）；
  `electron/macos-grok.test.ts` 把原来钉住「指着旧版也不动」的那条改成跟到新版，另加不带版本号布局、已对上不重写、
  事务里挪过又退回、快照记目标等用例（只在 macOS 上跑，CI 的 macos-test 作业跑）。新加的「跟到新版」「快照记目标」类用例在旧代码上红。

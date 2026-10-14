## 开发

- Gemini CLI 在同一版下线（`gemini-cli-retired.md`），检查页不再查它，下面 Gemini 文件夹信任这一项随之不再出现，原来的「用户」说明一并拿掉。
- xm 三线路 C16 剩下的两项诊断，都没加新的界面文字。
- Gemini 文件夹信任：`workspace-config-overrides.ts` 的 `inspectGemini` 先看 `~/.gemini/trustedFolders.json`，
  最近选的项目文件夹按 Gemini 0.62.0 `isPathTrusted` 的比法（规则管自己和下面的文件夹，`TRUST_PARENT` 管上一层，
  听路径最长的那条，Windows / macOS 不分大小写）算出是 `DO_NOT_TRUST` 时，只报这一条
  `launchUnaffected` 的结果，检查页沿用「自己开终端……不会用当前账号，从本软件打开不受影响」那句（需留意）。
  不信任时 Gemini 不读 `~/.gemini/.env`、也不读项目里的 `.gemini/settings.json`（沙箱里假 HOME + 本地假接口跑过
  0.62.0），所以那两样这时不再另报；以前项目 settings.json 换了登录方式会报成「待处理」并在打开时弹提醒，
  其实打开不受影响。没记过的文件夹不报（交互界面第一次进来会先问）；用户级 settings.json 关了
  `security.folderTrust.enabled` 时不报。
- Codex 后台服务：`config-files.ts` 新增 `codexDaemonAutoStartSetting` / `inspectCodexDaemonAutoStart`，读
  `[features] daemon_auto_start` 与顶层 `profile` 选中的 `[profiles.<名>.features]`（后者盖过前者，照
  rust-v0.160.1 / 0.162.1 `features/src/lib.rs`，缺省开）。「Codex 连接设置」接的是当前账号时，导出报告的
  details 多一个 `daemonAutoStart`（开 / 关 / 没写），检查页详情不列。只读不改。

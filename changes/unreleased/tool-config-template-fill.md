## 用户

- 老用户的工具设置会自动跟上新版：开机时软件会给以前接好的 Codex、Claude Code、Gemini CLI、Grok CLI 补上后来新增的几项设置（比如 Codex 跑完不再卡十秒、Windows 上不再弹英文沙箱框、Claude Code 能读网页、Gemini 搜索不再转两分半、Grok 画图走当前账号）。只补没有的，你自己改过的设置不动；补之前会在「备份」页留一份，工具正开着时不补、下次开机再补。补了会在右下角说一次。

## 开发

- 配置模板加版本号 `relayTemplateRevision`（`electron/config-files.ts`），记进工具配置来源记录的 `templateRevision`；完整保存时记当前版本。新增 `fillRelayTemplateDefaults` / `relayTemplateDefaultsPending`：只补缺省键，配置不指向当前账号服务就不动，写入沿用 `executeFilePlans` 两阶段提交与 `.bak`。
- 新通道 `config:fill-template-defaults`（ipc-contract / preload / ipc 三处同序，紧跟 `tools:check-models`）：主进程只处理来源为 `account`、版本落后的配置，先 `inspectRunningTools` 跳过开着或看不出的工具，补之前建一份 `pre-save` 备份，已经齐了只抬版本号不留备份；失败记 `template-defaults.failed` 日志、版本号不前进。
- renderer-v2 在 `restore` 模式的账号恢复结束后调用，真补了才出角落卡片（`startup-notice` 新 id `template-filled`）。加项规矩写在 `docs/CLI-VERIFIED-VERSIONS.md`「老客户的配置怎么跟上这张表」。

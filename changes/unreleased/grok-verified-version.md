## 用户

- Grok 也有推荐版本了：首页 Grok 那行显示「推荐 1.0.44」，点「更新」装的是我们核过的这一版，不再是官方刚发的新版；更新之后觉得不对，「…」菜单里可以「退回更新前的版本」。想一直用最新版的，在「设置」里打开「命令行工具总是装最新版」照旧。

## 开发

- 第十七批 8。`cli-verified-versions.ts` 的 Grok 条目从 `null` 改为 `1.0.44`（npm `latest` 与 xAI stable 一致）；沙箱假接口核过 `allowed_models`、`session_summary`、`[endpoints] xai_api_base_url`、钩子四项在 1.0.44 上仍生效，过程写进 `docs/CLI-VERIFIED-VERSIONS.md`。
- Grok 两条官方安装路径原先无视点名版本、只装 xAI stable：新增 `grok-update.ts` 的 `resolveGrokInstallVersion`（点名版本不超过 stable 就装它，超过装 stable，只收 `x.y.z`），Windows 的 `downloadLatestGrokBinary` 多收可选 `version`，Mac 的 `resolveCliInstallRelease` 按它选 npm 版本并照旧核对 npm 返回的版本号；签名校验不变。
- `cli-update-history.ts` 去掉 Grok 例外；`runCliInstall` 在装 Grok 前问一次已装版本（`readInstalledCliVersion`），Windows 签名包路径装完也记更新记录（记录逻辑抽成 `recordCliUpdate`）。
- 中转实测脚本 `probe-cli-relay.cjs` 仍不探测 Grok（没有 runner，名单条目会被跳过）。

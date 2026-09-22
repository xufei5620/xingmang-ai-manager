## 用户

- 用当前账号跑 Gemini CLI 时，联网搜索、读网页、压缩对话、Auto 模式不会再卡几分钟后失败。

## 开发

- `electron/config-files.ts`：星芒来源的 Gemini `settings.json` 写 `modelConfigs.customOverrides`，把 0.60.0 后台功能写死的 Google 官方型号名（`gemini-3-flash-preview`、`gemini-3.1-pro-preview-customtools`、`gemini-3.1-flash-lite` 等 12 个，含 `flash` / `pro` 等别名）统一改写成当前配的中转型号，当前型号本身不写。merge 只替换本软件写的那种改写（`match` 只有 `model`、`modelConfig` 只有 `model`），用户自己的改写保留；切回 Google 账号时删掉。对应「接中转后的官方体验差距」G1，沙箱实测见 `docs/CLI-VERIFIED-VERSIONS.md`。

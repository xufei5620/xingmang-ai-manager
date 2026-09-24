## 用户

- Gemini CLI 的推荐版本升到 0.61.0：选了名字以 flash 结尾的型号时，不会再被悄悄换成别的型号；在 Gemini CLI 里切到新出的 Gemini 3.8 Flash 或 3.5 Flash Lite，也会自动走当前账号能用的型号。

## 开发

- `cli-verified-versions.ts` 的 Gemini 推荐版本 0.60.0 → 0.61.0（上游 #29252 不再把 `*-flash` 型号改发成 `gemini-3.5-flash`）；`geminiRelayHelperModels` 补上 0.61.0 新增的 `gemini-3.8-flash` / `gemini-3.5-flash-lite`。0.61.0 新加的出网改名会把恰好叫 `gemini-3.5-flash` / `gemini-3-flash` / `gemini-3.1-flash-lite` 的型号改发，沙箱实测与依据见 `docs/CLI-VERIFIED-VERSIONS.md`。

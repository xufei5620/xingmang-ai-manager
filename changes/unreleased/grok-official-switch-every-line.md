## 开发

- 0.2.24 深查「反复切换」N3：Grok 切回官方账号时 `removeGrokRelayConfig`（`config-files.ts`）只删 `base_url` 跟传进来的
  线路地址逐字相同的模型表和 `endpoints.xai_api_base_url`。对话表、出图地址、多出来的表停在这个站另一条线路或退役别名上时
  原样留着，界面说切好了、`officialProviders` 也记成官方，Grok 却还在走中转。现在逐字相同之外，再按
  `relayProviderBaseUrlMatches('grok', …)` 认这个站的每条线路和别名（不跨站，别的站和客户自己的地址照旧不碰）。
  整份配置停在另一条线路这种最常见的情况，main 上早已由 `providerRelaySite(provider, current, true)` 按配置自己那条线路删干净，
  这次补的是几处分别停在不同线路上的情况。用户更新说明满 60 条，只写这一段。

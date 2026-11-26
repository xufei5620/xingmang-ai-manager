## 开发

- 首页 Antigravity 两张卡装好后中间那行（yoyo 2026-11-26 回「谷歌卡介绍改」，方案第 4 条）：`registry/tools.ts` 新加 `antigravityInstalledMeta`「打开时自动使用当前账号」，
  `Home.tsx` 的 `renderAntigravity` 装好时用它，没装时照旧用 `homeToolBlurbs`。同时把 `homeToolBlurbs` 里三句口语改书面（Claude Desktop、Antigravity、Grok CLI、Codex 桌面端四张卡）。
  v4 原型里那几句还是旧的，原型不动。

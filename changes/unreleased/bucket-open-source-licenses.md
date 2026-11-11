## 开发

- 存储桶里转发的 Grok CLI（Windows）和 OpenCode 桌面端（Mac）补上许可文件（决定单 D98「桶照旧」，许可合规 LC-6）：
  `sync-grok-cos` 把 Apache-2.0 原文和 xAI 随包发的 `THIRD_PARTY_NOTICES.md`、`sync-opencode-cos` 把 MIT 原文，
  传到各自前缀的 `licenses/sha256-<摘要>/` 下（不可覆盖、完整回读），写进 `latest.json` 顶层新加的 `license`。
  许可文字原样放在 `scripts/cos-licenses/`，测试按 SHA-256 钉住；上传和清单校验在 `scripts/cos-license-files.cjs`。
  OpenCode 版本没变时只补传许可、不重下包。客户端不读这个字段（0.2.22 起两个解析都只认自己知道的键），装法不变。

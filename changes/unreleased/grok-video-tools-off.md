## 开发

- 接当前账号时替 Grok 写 `[features] video_gen = false`，关掉两个做视频工具（`image_to_video`、`reference_to_video`）：
  中转回的是 xAI 自己的视频地址，Grok 在客户电脑上直连下载，`x.ai` 在国内连不上，一条视频扣了钱却拿不到片。
  新模板、合并保存、老客户开机补缺省项（`relayTemplateRevision` 升到 8）三条路都写，客户自己写过这一项就不动，
  切回官方不收回。沙箱对 Grok 1.0.77 实测两个视频工具不再出现、不发视频请求，画图照旧（`docs/CLI-VERIFIED-VERSIONS.md` 的 K5）。

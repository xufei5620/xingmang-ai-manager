# 星芒中转生图协议

生产网关：`https://xm.solov.cc`（New API）。数字来自仓库 `docs/RECON-image-generation.md` 的实测记录。

## 鉴权与分组

- Header：`Authorization: Bearer sk-...`
- 生产网关固定 `https://xm.solov.cc`，不要改成第三方生图站
- 脚本先用 `config.json` 的 Codex Key（`GPT-中转/订阅`），失败再改用 `图片模型-中转/订阅`（或旧名 `生图分组`）
- 不要走 `/pg/chat/completions`
- Key 只存在本技能 `config.json`，由星芒AI管理工具写入；不要读环境变量或 CLI 配置

## 文生图 `POST /v1/images/generations`

只用 OpenAI 的 gpt-image 系列。不要传 `response_format`。

```json
{
  "model": "gpt-image-2",
  "prompt": "...",
  "n": 1,
  "size": "1024x1024",
  "quality": "low"
}
```

`model` 用 `config.json` 里星芒挑好的 `model`，没有就 `gpt-image-2`。

响应：`data[0].b64_json`（PNG）。

## 图生图 `POST /v1/images/edits`

只接受 `multipart/form-data`。字段：`model`、`prompt`、`image` 或 `image[]`（不要用 `images`）。`mask` 可选。

## 尺寸

| 模型 | 规则 |
|---|---|
| gpt-image-2、gpt-image-2.5-* | 宽高都是 16 的倍数 |
| gpt-image-1 | 仅 1024x1024 / 1024x1536 / 1536x1024 / auto |

## 画质

`low` / `medium` / `high` / `auto`。默认显式 `low`。文字密集海报用 `high`。

## 超时

客户端 ≥ 300 秒。

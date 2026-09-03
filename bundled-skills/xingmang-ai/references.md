# 星芒中转生图协议

生产网关：`https://xm.solov.cc`（New API）。数字来自仓库 `docs/RECON-image-generation.md` 的实测记录。

## 鉴权与分组

- Header：`Authorization: Bearer sk-...`
- 生产网关固定 `https://xm.solov.cc`，不要改成第三方生图站
- 脚本先用 `config.json` 的 Codex Key（`GPT-中转/订阅`），失败再改用 `图片模型-中转/订阅`（或旧名 `生图分组`）
- 不要走 `/pg/chat/completions`
- Key 只存在本技能 `config.json`，由星芒AI管理工具写入；不要读环境变量或 CLI 配置

## 文生图 `POST /v1/images/generations`

GPT Image / 即梦 / Grok 走这条。不要给 gpt-image 传 `response_format`。

```json
{
  "model": "gpt-image-2",
  "prompt": "...",
  "n": 1,
  "size": "1024x1024",
  "quality": "low"
}
```

即梦用 `extra_fields` 传宽高，不要传 `quality`：

```json
{
  "model": "jimeng_high_aes_general_v21_L",
  "prompt": "...",
  "n": 1,
  "extra_fields": { "width": 1024, "height": 1024 }
}
```

响应：

- gpt-image：`data[0].b64_json`（PNG）
- 即梦：`data[0].url`（约 24h 过期，必须立刻下载；`&` 必须经 JSON.parse 取值）

## Gemini `POST /v1/chat/completions`

`gemini-3.1-flash-image` 走 Chat Completions。Images API 会报 only imagen models are supported。

```json
{
  "model": "gemini-3.1-flash-image",
  "messages": [{ "role": "user", "content": "..." }],
  "stream": false,
  "extra_body": {
    "google": {
      "image_config": {
        "aspect_ratio": "1:1",
        "image_size": "1K"
      }
    }
  }
}
```

图片在 `choices[0].message.content` 的 Markdown data URL 里。不支持 `/v1/images/edits`。

比例：1:1、4:3、3:4、16:9、9:16、3:2、2:3、5:4、4:5、21:9。

## 图生图 `POST /v1/images/edits`

只接受 `multipart/form-data`。字段：`model`、`prompt`、`image` 或 `image[]`（不要用 `images`）。`mask` 可选。

## 尺寸

| 模型 | 规则 |
|---|---|
| gpt-image-2 | 宽高都是 16 的倍数 |
| gpt-image-1 | 仅 1024x1024 / 1024x1536 / 1536x1024 / auto |
| 即梦 | 常规像素尺寸，放进 `extra_fields` |
| Gemini | 只传比例 |

## 画质

仅 gpt-image：`low` / `medium` / `high` / `auto`。默认显式 `low`。文字密集海报用 `high`。

## 超时

客户端 ≥ 300 秒。

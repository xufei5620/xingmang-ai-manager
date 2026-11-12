# 生图接口说明

接口地址用 `config.json` 里的 `baseUrl`（登录时按当前账号的线路写好）。下面的数字是 2026-11-11 实测的。

## 鉴权与分组

- OpenAI、Grok：Header `Authorization: Bearer sk-...`
- Nano Banana（Gemini 原生接口）：Header `x-goog-api-key: sk-...`（`Bearer` 站上也认）
- 接口地址只用 `config.json` 的 `baseUrl`，不要改成第三方生图站
- OpenAI 模型先用 `config.json` 的 Codex Key（`GPT`），401/403/429/503 再改用 `图片模型`（或旧名 `生图分组`）
- Nano Banana 和 Grok 只在 `图片模型` 分组里有，只用那把 Key；账号没有就提醒用户登录或开通
- 不要走 `/pg/chat/completions`
- Key 只存在本技能 `config.json`，登录时自动写入；不要读环境变量或 CLI 配置

## 模型和价格（每张）

| 模型 | 价格 | 接口 |
|---|---|---|
| `gpt-image-2.6-flare`、`gpt-image-2.5-flare`、`gpt-image-2` | 1K、2K ¥0.2，4K ¥0.3；low/medium/high 同价 | Images API |
| `gpt-image-2.6-sunburst`、`gpt-image-2.5-sunburst` | 同上 | Images API |
| `gpt-image-2.6`、`gpt-image-2.5`（不带后缀） | 同上 | Images API，只在图片模型分组有 |
| `nano-banana-2`（= `gemini-3.1-flash-image`） | ¥0.2 | Gemini 原生接口 |
| `nano-banana-pro` | ¥0.3，4K ¥0.4 | Gemini 原生接口（`gemini-3-pro-image` 这个名字站上还没有渠道） |
| `grok-imagine-image` | ¥0.2 | Images API |
| `grok-imagine-image-2.0`、`grok-imagine-image-quality` | ¥0.5 | Images API |

默认用 `config.json` 的 `model`（登录时按当前账号挑好的），失败按 `fallbackModels` 依次换；都没有就 `gpt-image-2`。`gpt-image-1` 官方已下线，`gpt-image-1.5` 站上调不通，都不要用。

## OpenAI 文生图 `POST /v1/images/generations`

不要传 `response_format`。

```json
{
  "model": "gpt-image-2.6-flare",
  "prompt": "...",
  "n": 1,
  "size": "1024x1024",
  "quality": "high"
}
```

可选 `background`：`opaque` / `transparent` / `auto`。响应：`data[0].b64_json`（PNG）。

## OpenAI 图生图 `POST /v1/images/edits`

只接受 `multipart/form-data`。字段：`model`、`prompt`、`size`、`quality`，一张图用 `image`，多张用 `image[]`（不要用 `images`）。`mask` 可选。

## Nano Banana `POST /v1beta/models/{model}:generateContent`

站上 Gemini 渠道走 `/v1/images/generations` 会回 500「only imagen models are supported」，只能走这个。

```json
{
  "contents": [{ "role": "user", "parts": [{ "text": "..." }] }],
  "generationConfig": {
    "responseModalities": ["IMAGE"],
    "imageConfig": { "imageSize": "1K", "aspectRatio": "16:9" }
  }
}
```

`imageSize` 是 `1K` / `2K` / `4K`。改图时把参考图加进 `parts`：`{ "inlineData": { "mimeType": "image/png", "data": "<base64>" } }`。图在 `candidates[0].content.parts[].inlineData.data`（JPEG，1K 16:9 实测 1376x768）。没图时 `parts` 里是一段文字，说明为什么。

## Grok `POST /v1/images/generations`

```json
{ "model": "grok-imagine-image", "prompt": "...", "n": 1, "response_format": "b64_json" }
```

不传 `response_format` 会回一个很快过期的地址。实测只出 1280x720 的 JPEG，传 `size`、`aspect_ratio` 都不变。改图走 `/v1/images/edits`，字段同上。

## 尺寸

| 模型 | 规则 |
|---|---|
| gpt-image-2 / 2.5 / 2.6 系列 | 宽高都是 16 的倍数，长边不超过 3840，总像素 655,360 到 8,294,400 |
| Nano Banana | `imageSize` 1K/2K/4K 加 `aspectRatio` |
| Grok | 不能指定 |

脚本的 `--size 1K|2K|4K --aspect 比例` 按长边 1024 / 2048 / 3840 换成宽高，比例不变、超了像素上限等比缩：

| | 1:1 | 16:9 | 4:3 | 3:2 |
|---|---|---|---|---|
| 1K | 1024x1024 | 1280x720 | 1024x768 | 1008x672 |
| 2K | 2048x2048 | 2048x1152 | 2048x1536 | 2016x1344 |
| 4K | 2880x2880 | 3840x2160 | 3264x2448 | 3504x2336 |

竖版把宽高对调。

## 画质

`low` / `medium` / `high` / `auto`，只对 gpt-image 有用。站上各档同价，实测 `gpt-image-2.6-flare` 三档各 3 张，low 平均 25.9 秒、medium 27.5 秒、high 24.4 秒，所以默认 `high`。

## 超时

客户端 ≥ 300 秒。

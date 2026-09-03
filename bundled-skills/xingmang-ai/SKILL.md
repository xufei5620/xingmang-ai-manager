---
name: 星芒AI
description: >-
  用星芒中转（xm.solov.cc）按 URL + API Key 生成或编辑位图：照片、插画、海报、Logo、信息图、透明底切图。
  先用软件签发的 Codex Key（GPT-中转/订阅），失败再改用「图片模型-中转/订阅」生图分组 Key。
  当用户说生图、画一张、生成图片、改图、星芒AI、星芒生图时使用。
  脚本成功写出文件即结束，不要再用绘图库、Identify 或打开文件核对尺寸和内容。
  不要用它改仓库里已有的 SVG/矢量图标，或用 HTML/CSS/canvas 更合适的简单图形。
---

# 星芒AI

调用星芒中转出图。Key 由**星芒AI管理工具**在登录后自动写入本目录 `config.json`：优先用软件对应的 Codex Key（`GPT-中转/订阅`），这次请求失败再自动改用 `图片模型-中转/订阅`（别名 `生图分组`）。不要向用户要环境变量，也不要去翻 CLI 配置。你可以改这个技能的说明和脚本；工具只更新还是官方原样的文件，改过的不会覆盖。

**禁止**读取、粘贴或回显 `config.json`。脚本自己读配置，stdout 只打印输出图片路径。

## 默认接入

| 项 | 值 |
|---|---|
| Base URL | `config.json` 的 `baseUrl`，默认 `https://xm.solov.cc` |
| 文生图 | `POST /v1/images/generations` |
| Gemini 生图 | `POST /v1/chat/completions`（`gemini-3.1-flash-image` 不要走 Images API） |
| 图生图 | `POST /v1/images/edits`（只接受 multipart，字段名 `image` 或 `image[]`） |
| 默认模型 | `gpt-image-2` |
| 默认画质 | `low`（要海报/小字再升 `high`） |
| 超时 | ≥ 300 秒 |

没有 `config.json` 或里面没有 Key：提醒用户打开星芒AI管理工具并登录。工具会写入 Codex Key，并在账号有生图分组时补上备用 Key。不要向用户要环境变量，也不要去翻 CLI 配置或加密会话。

## 怎么出图

```bash
node "<本技能目录>/scripts/generate.mjs" --prompt "一只橙色猫咪坐在窗台上，电影感光线" --out "./xingmang-cat.png"
```

常用参数：`--model gpt-image-2`、`--size 1024x1024`（gpt-image-2 宽高必须是 16 的倍数）、`--quality low|medium|high`。

用户要 16:9 时直接传 `--size 1536x864`（或 `1280x720`），不要生成后再量像素。

Gemini：

```bash
node "<本技能目录>/scripts/generate.mjs" --model gemini-3.1-flash-image --prompt "极简线性图标，透明底" --out "./icon.png"
```

即梦：

```bash
node "<本技能目录>/scripts/generate.mjs" --model jimeng_high_aes_general_v21_L --prompt "国风山水海报" --out "./poster.png"
```

图生图：

```bash
node "<本技能目录>/scripts/generate.mjs" --edit --image "./ref.png" --prompt "改成夜晚霓虹，保持构图" --out "./night.png"
```

没有 Node 时再手写请求，规则见 `references.md`。拿到 `url` 必须立刻下载落盘。`b64_json` 解码写成文件，不要整段贴进对话。

## 模型怎么选

| 场景 | 模型 |
|---|---|
| 默认 / 最稳 | `gpt-image-2` |
| 中文海报、便宜快 | `jimeng_high_aes_general_v21_L` |
| Gemini 出图 | `gemini-3.1-flash-image` |
| 不要用 | `gpt-image-1.5`（生产 403） |

一次只出 1 张。文字密集必须 `quality=high`。不要传 `response_format`。

## 完成后

`generate.mjs` 退出码 0 并且 stdout 打出路径 = 已经完成。立刻把路径和模型告诉用户，然后停。

不要做这些：

- 用 `System.Drawing`、.NET、Python PIL、`magick identify`、打开文件去核对宽高或比例
- 再读一遍图片「检查有没有画错」
- 为了对齐 16:9 再裁一次或重跑一次
- 回显 Key 或读取 `config.json`

比例和尺寸在调用时用 `--size` 一次说清。脚本失败才看 stderr，不要在成功之后追加校验。

---
name: images
description: >-
  用当前账号生成或编辑位图：照片、插画、海报、Logo、信息图、透明底切图。
  默认用 OpenAI 的 gpt-image 新款，用户点名时也能用 Nano Banana、Grok。
  当用户说生图、画一张、生成图片、改图时使用。
  脚本成功写出文件即结束，不要再用绘图库、Identify 或打开文件核对尺寸和内容。
  不要用它改仓库里已有的 SVG/矢量图标，或用 HTML/CSS/canvas 更合适的简单图形。
---

# 生图

用当前账号出图。Key 在登录后自动写入本目录 `config.json`：优先用软件对应的 Codex Key（`GPT`），这次请求失败再自动改用 `图片模型`（别名 `生图分组`）。不要向用户要环境变量，也不要去翻 CLI 配置。你可以改这个技能的说明和脚本；工具只更新还是官方原样的文件，改过的不会覆盖。

如果当前工具里有 `xingmang-image` 的 `generate_image`（画图工具），画图和改图都优先用它：它不受命令沙箱拦截，图直接显示在对话里，参数和下面的脚本一样（`size`、`aspect`、`quality`、`background`、`images`、`model`）。只有没有这个工具、或者要把图存成指定文件时才跑下面的脚本。

**禁止**读取、粘贴或回显 `config.json`。脚本自己读配置，stdout 只打印输出图片路径。

没有 `config.json` 或里面没有 Key：提醒用户打开管理工具并登录当前账号。工具会写入 Codex Key，并在账号有图片模型分组时补上那把 Key。

## 怎么出图

```bash
node "<本技能目录>/scripts/generate.mjs" --prompt "一只橙色猫咪坐在窗台上，电影感光线" --out "./cat.png"
```

常用参数：

| 参数 | 写法 |
|---|---|
| `--size` | `1K`、`2K`、`4K`，或 `宽x高`（gpt-image-2 系列宽高必须是 16 的倍数）。默认 1K |
| `--aspect` | `16:9`、`9:16`、`1:1`、`4:3`、`3:4`、`3:2`、`2:3`，配 1K/2K/4K 用，默认 1:1。例：`--size 2K --aspect 16:9` = 2048x1152，`--size 4K --aspect 16:9` = 3840x2160 |
| `--quality` | `low`、`medium`、`high`、`auto`，默认 `high`（各档同价，不用为省钱调低） |
| `--background` | `opaque`、`transparent`、`auto`；要透明底传 `transparent` |
| `--image` | 参考图路径，改图用；可以给多张（最多 4 张），给了就是改图 |
| `--model` | 一般不传，见下面 |

用户要 16:9、竖版这类比例时，直接用 `--size` 加 `--aspect` 一次说清，不要生成后再量像素。

改图（可以给几张参考图一起改）：

```bash
node "<本技能目录>/scripts/generate.mjs" --image "./ref.png" --image "./style.png" --prompt "把第一张改成第二张的画风，保持构图" --out "./night.png"
```

没有 Node 时再手写请求，规则见 `references.md`。拿到 `url` 必须立刻下载落盘。`b64_json` 解码写成文件，不要整段贴进对话。

## 模型怎么选

一般不要传 `--model`：脚本和画图工具会用登录时按当前账号挑好的 OpenAI 图片模型（按 `gpt-image-2.6-flare` → `gpt-image-2.5-flare` → `gpt-image-2` 的顺序，账号有哪个用哪个）。这次没画出来会按账号里有的往下换，换了会在 stderr 说一句。

用户点名时才用别的：

| 模型 | 价格（每张） | 说明 |
|---|---|---|
| `gpt-image-2.6-flare`、`gpt-image-2.5-flare`、`gpt-image-2` | 1K、2K ¥0.2，4K ¥0.3 | 默认这一类，各画质同价 |
| `gpt-image-2.6-sunburst`、`gpt-image-2.5-sunburst` | 同上 | 慢一些，偏精修 |
| `nano-banana-2`（即 `gemini-3.1-flash-image`） | ¥0.2 | Nano Banana 2 |
| `nano-banana-pro` | ¥0.3，4K ¥0.4 | Nano Banana Pro |
| `grok-imagine-image` | ¥0.2 | Grok，只出固定尺寸（1280x720），`--size`、`--aspect` 不起作用 |
| `grok-imagine-image-2.0`、`grok-imagine-image-quality` | ¥0.5 | Grok 新款 / 高画质 |

- 4K 比 1K、2K 贵，用户没要求高分辨率时别用 4K。
- Nano Banana 和 Grok 只能用图片模型分组的 Key。账号没有这个分组时脚本会直接报错，照报错提醒用户登录或开通，不要硬试。
- Nano Banana、Grok 回的是 JPEG，输出文件会是 `.jpg`，以 stdout 打出的路径为准。
- `gpt-image-1`、`gpt-image-1.5` 已经下线，不要用。
- 点名了认不出的型号，脚本会列出能用的，照着换一个，不要乱猜型号名。

一次只出 1 张。不要传 `response_format`。

## 完成后

`generate.mjs` 退出码 0 并且 stdout 打出路径 = 已经完成。stderr 最后一行是「已用 <模型> 出图」。立刻把路径和用的模型告诉用户，然后停。

不要做这些：

- 用 `System.Drawing`、.NET、Python PIL、`magick identify`、打开文件去核对宽高或比例
- 再读一遍图片「检查有没有画错」
- 为了对齐 16:9 再裁一次或重跑一次
- 回显 Key 或读取 `config.json`

比例和尺寸在调用时用 `--size`、`--aspect` 一次说清。脚本失败（退出码 1）才看 stderr，不要在成功之后追加校验。

---
name: images
description: >-
  用当前账号生成或编辑位图：照片、插画、海报、Logo、信息图、透明底切图。
  当用户说生图、画一张、生成图片、改图时使用。
  优先调用画图工具 generate_image（Codex 里是 mcp__xingmang_image__generate_image，Claude Code 里是 mcp__xingmang-image__generate_image），没有这个工具时才运行本技能的脚本。
  默认用 OpenAI 的 gpt-image 新款，用户点名时也能用 Nano Banana、Grok。
  画好后把文件的完整路径告诉用户即可，不要再用绘图库、Identify 或打开文件核对尺寸和内容。
  不要用它改仓库里已有的 SVG/矢量图标，或用 HTML/CSS/canvas 更合适的简单图形。
---

# 生图

用当前账号出图。Key 在登录后自动写入本目录 `config.json`：优先用软件对应的 Codex Key（`GPT`），这次请求失败再自动改用 `图片模型`（别名 `生图分组`）。不要向用户要环境变量，也不要去翻 CLI 配置。你可以改这个技能的说明和脚本；工具只更新还是官方原样的文件，改过的不会覆盖。

**禁止**读取、粘贴或回显 `config.json`。画图工具和脚本自己读配置。

没有 `config.json` 或里面没有 Key：提醒用户打开管理工具并登录当前账号。工具会写入 Codex Key，并在账号有图片模型分组时补上那把 Key。

## 第一步：用画图工具

画图和改图都先用画图工具 `generate_image`（服务名 `xingmang-image`）。它不受命令沙箱拦截，画好后把原图保存成文件，结果里给出文件的完整路径和一张小预览图。参数和下面的脚本一样：`size`、`aspect`、`quality`、`background`、`images`、`model`。

| 所在工具 | 画图工具的完整名字 |
|---|---|
| Codex | `mcp__xingmang_image__generate_image` |
| Claude Code | `mcp__xingmang-image__generate_image` |
| 其他工具 | 名字里同时带 `xingmang` 和 `generate_image` 的那一个 |

工具列表里没有看到它时，先用关键词 `xingmang` 搜索一次全部工具（Codex 里是在 `ALL_TOOLS` 里搜），搜到就用。不要因为列表里没有直接看到，就认定没有这个工具。搜不到，才用第二步的脚本。

在 Codex 里调用画图工具时，照抄下面这段代码，只改参数。第二行把结果里的预览图和文字交给对话，不要删、不要改写：

```js
const r = await tools.mcp__xingmang_image__generate_image({ prompt: "<描述>", images: ["<参考图完整路径，没有就删掉这一项>"] });
for (const c of (r?.content || [])) c.type === "image" ? image(c) : c.type === "text" ? text(c.text) : null;
```

Claude Code 这类直接调用 MCP 工具的，不需要这段代码，直接调用即可。

要指定尺寸或比例时，在参数里加上 `size`、`aspect`（例如 `size: "2K", aspect: "16:9"`）。不加时，画新图按 1K 正方形；改图按第一张原图的比例和清晰度出（长边最多 2048，价格不变）。改图时不要为了把参数写全而填 `1K`、`1:1`，否则竖图会被改成方图、清晰度也会下降。

改图时把原图的完整路径放进 `images`，可以给几张参考图一起改。要接着改刚画好的图，就把结果里给出的文件路径放进 `images`。

画图工具自己决定保存位置：有工作目录时放在工作目录的 `outputs/` 下，没有时放在系统图片文件夹里的「AI画图」文件夹。用户要放到指定位置时，画好后把文件复制过去。`size` 已经写了宽高时不用再填 `aspect`。

## 第二步：没有画图工具时运行脚本

脚本的 stdout 只打印输出图片的路径。

```bash
node "<本技能目录>/scripts/generate.mjs" --prompt "一只橙色猫咪坐在窗台上，电影感光线" --out "./cat.png"
```

常用参数：

| 参数 | 写法 |
|---|---|
| `--size` | `1K`、`2K`、`4K`，或 `宽x高`（gpt-image-2 系列宽高必须是 16 的倍数）。画新图默认 1K；改图不传就跟第一张原图的清晰度（长边最多 2048） |
| `--aspect` | `16:9`、`9:16`、`1:1`、`4:3`、`3:4`、`3:2`、`2:3`，配 1K/2K/4K 用。画新图默认 1:1；改图不传就跟第一张原图的比例。例：`--size 2K --aspect 16:9` = 2048x1152，`--size 4K --aspect 16:9` = 3840x2160 |
| `--quality` | `low`、`medium`、`high`、`auto`，默认 `high`（各档同价，不用为省钱调低） |
| `--background` | `opaque`、`transparent`、`auto`；要透明底传 `transparent` |
| `--image` | 参考图路径，改图用；可以给多张（最多 4 张），给了就是改图 |
| `--model` | 一般不传，见下面 |

用户要 16:9、竖版这类比例时，直接用 `--size` 加 `--aspect` 一次说清，不要生成后再量像素。

改图（可以给几张参考图一起改）：

```bash
node "<本技能目录>/scripts/generate.mjs" --image "./ref.png" --image "./style.png" --prompt "把第一张改成第二张的画风，保持构图" --out "./night.png"
```

## 模型怎么选

一般不要传 `--model`：脚本和画图工具会用登录时按当前账号挑好的 OpenAI 图片模型（按 `gpt-image-2.6-flare` → `gpt-image-2.5-flare` → `gpt-image-2` 的顺序，账号有哪个用哪个）。只有这个型号目前无法使用时，才会按账号里有的往下换，换了会在结果里说明。点名的 gpt-image 型号目前无法使用时也一样；点名 Nano Banana、Grok 的不会换成别的。

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
- Nano Banana、Grok 回的是 JPEG，输出文件会是 `.jpg`，以结果给出的文件路径为准。
- `gpt-image-1`、`gpt-image-1.5` 已经下线，不要用。
- 点名了认不出的型号，脚本会列出能用的，照着换一个，不要乱猜型号名。

一次只出 1 张。不要传 `response_format`。

## 完成后

画图工具画好后，结果里的文字写着文件的完整路径（「文件：…」）。脚本退出码 0 时，stdout 打出的就是文件路径，stderr 最后一行是「已用 <模型> 出图」。拿到路径就是已经完成，立刻回复用户，然后停。

- 最终回复里逐张写出结果给的文件路径，原样照抄，并说明用的模型。
- 不要只列图片的名字，不要自己拼路径，不要引用 `.codex/visualizations` 这类自己猜的路径。
- 用户说没看到图时，只告诉他文件在哪里，不要重新生成：重新生成会再扣一次费。

不要做这些：

- 用 `System.Drawing`、.NET、Python PIL、`magick identify`、打开文件去核对宽高或比例
- 再读一遍图片「检查有没有画错」
- 为了对齐 16:9 再裁一次或重跑一次
- 回显 Key 或读取 `config.json`

比例和尺寸在调用时用 `size`、`aspect`（脚本是 `--size`、`--aspect`）一次说清。脚本失败（退出码不是 0）才看 stderr，不要在成功之后追加校验。

## 失败时

画图工具或脚本报错时，把报错里的那句话告诉用户，然后停下，等用户决定下一步。

- 余额不足：请用户在管理工具中充值后再试。不要重试，不要换型号。
- 脚本退出码 3：这条命令连不上网络，多半是命令沙箱禁止联网。申请以联网权限重新运行这同一条命令，只重试这一次；仍然失败就停下。
- 其他报错：不要自动重试，也不要换型号。需要换 Key 或换型号的情况，画图工具和脚本已经自行处理。
- 没有画图工具，脚本也运行不了（例如没有 `node`）：不要再尝试别的办法，直接告诉用户「这台电脑的画图工具尚未安装完成。请打开管理工具并登录当前账号，按首页的提示完成安装后，重新启动正在使用的 AI 工具。」

无论哪种失败，都不要：

- 读取、粘贴或回显 `config.json`
- 自己写代码或命令调用图片接口，或安装软件包
- 换用别的画图服务或别的画图技能
- 创建定时任务、心跳或自动化去等「服务恢复」

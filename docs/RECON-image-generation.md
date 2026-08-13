# 星芒AI 图片生成接入文档（给无限画布）

> 版本：2026-08-12 · 依据：xm.solov.cc 生产环境全链路实测（含与 OpenAI 官方账单逐笔对账）
> 网关：New API v1.0.0-rc.24 · 所有数字均为实测值，非文档抄录

---

## 1. 基本接入

| 项 | 值 |
|---|---|
| Base URL | `https://xm.solov.cc` |
| 文生图端点 | `POST /v1/images/generations`（JSON） |
| 图生图端点 | `POST /v1/images/edits`（**multipart/form-data，不接受 JSON**） |
| 鉴权 | `Authorization: Bearer sk-xxx`（星芒后台「API 密钥」页签发） |
| 令牌分组 | 令牌须属于包含目标模型的分组：`openai`（含全部 gpt-image + 文本模型）或 `生图分组`（gpt-image + 即梦） |
| 超时建议 | **客户端 ≥ 300 秒**。4K high 实测最长 183 秒；网关侧 nginx 已放宽到 1800s，瓶颈只在客户端 |

> ⚠️ 不要走 `/pg/chat/completions`（游乐场通道）或聊天接口生图。即梦等原生协议模型在聊天通道会报 `missing req_key`——图片必须走 images 专用端点。

---

## 2. 可用模型清单（实测状态）

| 模型 ID | 提供方 | 端点 | 响应格式 | 状态 |
|---|---|---|---|---|
| `gpt-image-2` | OpenAI 官方 | generations / edits | **b64_json** | ✅ 主力，实测最稳 |
| `gpt-image-2-2026-04-21` | OpenAI 官方 | 同上 | b64_json | ✅（`gpt-image-2` 的实际快照版，行为一致） |
| `gpt-image-1` | OpenAI 官方 | 同上 | b64_json | ✅ 可用，但同画质成本高于 image-2，无理由不选 |
| `gpt-image-1.5` | OpenAI 官方 | — | — | ❌ 项目权限 403，**暂不可用，不要暴露给用户** |
| `jimeng_high_aes_general_v21_L` | 火山引擎即梦 | 仅 generations | **url**（字节 CDN） | ✅ 可用；便宜、快（8–20s），中文语义好 |

---

## 3. 请求参数规则（按模型区分，实测校验行为）

### 3.1 尺寸 `size`

| 模型 | 规则 | 非法时的报错 |
|---|---|---|
| gpt-image-2 系 | **任意尺寸，但宽、高都必须是 16 的倍数**（如 1536x1152、3840x2160、720x1280） | `Invalid size 'WxH'. Width and height must both be divisible by 16.` |
| gpt-image-1 | 仅 `1024x1024` / `1024x1536` / `1536x1024` / `auto` 四选一 | `Invalid size ... Supported sizes are 1024x1024, 1024x1536, 1536x1024, and auto.` |
| 即梦 | `1024x1024` 等常规尺寸 | — |

**前端务必做 16 倍数校验**（gpt-image-2），否则请求直接 400 浪费一次往返。

### 3.2 画质 `quality`（仅 gpt-image 系）

- 合法值：`low` / `medium` / `high` / `auto`（不传 = auto）
- 非法值报错：`Invalid value: 'ultra'. Supported values are: 'low', 'medium', 'high', and 'auto'.`
- ⚠️ **auto 陷阱（重要）**：auto 由 OpenAI 按提示词复杂度自动选档。实测同尺寸下，简单提示词落 low，复杂人像提示词**自动跳到 high，费用差可达 35 倍**。画布如需成本可控，**必须显式传 quality**，建议默认 `low`，用户手动升档。

### 3.3 其他

- `n`：每次 1 张（多张自行并发多请求）
- `prompt`：中文完全可用；文字密集的排版图（海报/信息图）**必须 high 档**，low 档中文小字会畸变错字
- 不要发送 `response_format`：当前 gpt-image 上游会返回 `Unknown parameter: 'response_format'`；客户端直接兼容响应中的 `b64_json` 与 `url` 即可

---

## 4. 响应格式差异（两个必须处理的坑）

### 4.1 gpt-image 系返回 `b64_json`

```json
{ "data": [ { "url": "", "b64_json": "iVBORw0KG..." } ] }
```

前端用 `data:image/png;base64,` 前缀直接渲染，或转 Blob 存储。**4K 图 7–10MB**，画布展示务必生成压缩预览图，不要直接嵌原图。

### 4.2 即梦返回 `url`，且有两个坑

```json
{ "data": [ { "url": "https://p26-aiop-sign.byteimg.com/...?rk3s=...&x-expires=...&x-signature=..." } ] }
```

1. **`&` 转义**：原始 JSON 文本里 `&` 是 `&`。必须经 `JSON.parse` 后取值（parse 会自动还原）；任何字符串拼接/正则截取原文的做法都会得到打不开的 403 链接。
2. **URL 24 小时过期**（`x-expires` 签名）：画布若要持久保存，**必须在拿到 URL 后立即下载转存**，不能只存链接。

---

## 5. 图生图 `/v1/images/edits`（multipart 细节）

- **只接受 `multipart/form-data`**；JSON 请求会报 `Missing required parameter: 'images'`（该提示有误导性，别照它改字段名）
- 图片字段名：**`image` 或 `image[]`**（实测二者均可；`images` / `images[]` 均报 Unknown parameter）
- 可传多张参考图（`image[]` 重复出现，实测 1 张原图 ≈ 857 输入 token）
- `mask` 可选：PNG，**透明区域 = 要重绘的部分**（局部重绘/消除）
- 浏览器端用 FormData 时**不要手动设置 Content-Type**（boundary 必须由浏览器生成）

```bash
curl -X POST https://xm.solov.cc/v1/images/edits \
  -H "Authorization: Bearer sk-xxx" \
  -F "model=gpt-image-2" -F "prompt=把猫换成白色布偶猫" \
  -F "size=1024x1024" -F "quality=low" -F "n=1" \
  -F "image[]=@origin.png;type=image/png"
```

- 仅 gpt-image 系支持 edits；即梦不支持
- 成本增量小：1 张 720×1280 原图仅 +857 输入 token（≈总成本 +6%），大头永远在输出

---

## 6. 实测性能与计费（用户侧实付价，人民币）

> 计费方式：gpt-image 系按 token（输入/输出分开计），即梦按次。
> 下表全部为真实请求实测，token 数与 OpenAI 官方账单逐笔核对一致。

### 6.1 gpt-image-2 · 尺寸 × 画质 实测矩阵

| 尺寸 | 画质 | 输出 token | 耗时 | **用户实付** |
|---|---|---|---|---|
| 1024×1024 | low | 196 | 36s | ≈0.055 元 |
| 1024×1024 | medium | 1756 | 53s | ≈0.49 元 |
| 1024×1024 | high | 7024 | 152s | ≈1.96 元 |
| 1536×1152（4:3） | low | 181 | 39s | 0.086 元 |
| 1536×1152 | medium | 1629 | 63s | 0.49 元 |
| 1536×1152 | high | 6514 | 183s | 1.85 元 |
| 3840×2160（4K） | low | 371 | 50s | 0.14 元 |
| 3840×2160 | medium | 3336 | 82s | 0.97 元 |
| 3840×2160 | high | 13342 | 129s | 3.76 元 |

规律（可直接用于画布的费用预估器）：
- 输出 token ≈ f(尺寸, 画质)，与提示词内容弱相关（同档位波动小）
- **像素 ×4.7 时 token 仅 ×2.05**：原生出 4K 比"小图放大"划算，单位像素成本约为小图的 44%
- 档位比例约 low : medium : high ≈ 1 : 9 : 36
- 费用估算公式：`实付元 ≈ (输入token×0.0000465 + 输出token×0.000279)`（已含倍率，按当前定价）

### 6.2 即梦

| 项 | 值 |
|---|---|
| 计费 | 按次固定（当前 0.028 元/张，**内部定价待调整，画布不要写死此数**） |
| 耗时 | 8–20 秒，全场最快 |
| 特点 | 中文提示词语义好；无 quality/尺寸档位那么多花样 |

### 6.3 耗时给 UX 的含义

生成是**长任务**（36s–183s）。画布必须做异步 UX：即时占位 + 进度态 + 完成回填，禁止同步阻塞等待；耗时与画质档强相关，可按上表给用户预估时间。

---

## 7. 错误处理对照表（全部实测遇到过）

| HTTP | 错误特征 | 含义 | 画布应对 |
|---|---|---|---|
| 400 | `Invalid size ...divisible by 16` | 尺寸不合法 | 前端校验拦截，不该到达后端 |
| 400 | `Invalid value ... 'low', 'medium', 'high', 'auto'` | 画质值不合法 | 同上 |
| 400 | `Unknown parameter: 'images'` | edits 用了 JSON 或错误字段名 | 改 multipart + `image[]` |
| 403 | `Project ... does not have access to model` | 模型无权限（如 gpt-image-1.5） | 从模型列表隐藏该模型 |
| 403 | `用户额度不足` `insufficient_user_quota` | 令牌/账户余额不足 | 提示充值，勿重试 |
| 429 | `exceeded your current quota` | 上游限流 | 指数退避重试或提示稍后 |
| 500 | 上游偶发 | 网关会自动换渠道重试（实测 `use_channel:["4","9"]`），多数场景用户无感 | 客户端不必自行重试同请求 |
| 504 | 网关超时 | 客户端超时设太短所致 | 超时 ≥300s |

失败请求**不扣费**（实测多次 403/429/503 均 quota=0）。

---

## 8. 给画布的集成建议清单

1. **模型下拉只放 3 个**：`gpt-image-2`（默认）、`gpt-image-1`、`jimeng_high_aes_general_v21_L`；隐藏 1.5 和快照版
2. **quality 显式传参**，默认 `low`；"高清出图"按钮才用 `high`，并在 UI 上提示费用与耗时差
3. **尺寸预设 + 自定义校验**：预设 1024²、1536×1152（4:3）、1280×720（16:9）、720×1280（9:16）、3840×2160（4K）；自定义输入实时校验 16 倍数
4. **草稿→定稿工作流**：构图阶段 low（约 0.09 元/张），确认后同参数 high 重出（比全程 high 省 95%）
5. **b64 与 url 双分支处理**；即梦 URL **立即转存**
6. 4K 原图落库 + 生成缩略图，画布视口内只渲染缩略图
7. 图生图入口：选中画布上已有图片 → "AI 改图"，multipart 上传该图 + 提示词；支持蒙版则透传 `mask`
8. 长任务异步化：请求发出即返回占位节点，完成后回填；断线重连场景可轮询星芒后台"使用日志"确认是否已扣费成功

---

## 附：一次典型成功响应（文生图，节选）

```json
{
  "created": 1786475468,
  "data": [ { "url": "", "b64_json": "iVBORw0KGgoAAAANSUhEUgAA..." , "revised_prompt": "" } ]
}
```

有任何与本文档不符的行为，以 xm.solov.cc 实际返回为准；本文档所有数值均可在星芒后台「使用日志」中复核。

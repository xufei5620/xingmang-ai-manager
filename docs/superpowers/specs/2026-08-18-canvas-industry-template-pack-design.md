# 画布行业模板包可实施设计

**日期：** 2026-08-18

**基线：** `claude/session-1-5l68rp@9d404183ca6777ff5c4e1074df8c52bacf651ec1`

**输入：** `docs/CANVAS-TEMPLATE-PACK-PLAN.md`、本地《画布行业蓝图》、当前 `canvas-v2` 与 Electron 主进程实现

**状态：** 可进入实现；原模板稿不能原样转写

## 1. 结论

推荐把本项目做成“行业任务入口 + 真实付费预检 + 可展开画布”，但第 0 步不能直接把 20 套模板复制进 `builtin-templates.ts`。

当前最可靠的实现方式是：

1. 保持“一张图 = 一个显式图像节点 = 一个付费请求”。
2. 需要四张候选时，在模板内放四个并行生成或编辑节点，不使用无效的 `count: 4`。
3. 需要六种风格各两张时，放十二个并行编辑节点；主进程继续以并发 2 排队。
4. 先让 Gallery 真正汇总多个上游节点的首个结果，但不把它宣传成“暂停并等待人工选择”的执行闸门。
5. 模板按行业展示，用户先填写模板变量、选择本地素材，再插入画布；仍然绝不自动运行。
6. 首发 T09、T15、T12、T06；完整 T01 与大型漫剧/绘本骨架等候人工选择闸门或完成拓扑重写后发布。

这条路线不会扩大 renderer 的网络权限，不会向画布暴露 API Key，也不依赖未经生产实测的上游批量参数。

## 2. 已核实的现状

### 2.1 当前真实执行链

```text
模板/编辑器
  → App.toCanvasRunGraph()
  → window.xingmangCanvasHost.startRun()
  → electron/canvas-window.ts
  → parseCanvasStartRunInput()
  → CanvasRunService
  → executeCanvasRun()
  → createCanvasNodeExecutors()
  → AiImageService / AiVideoService
```

生产付费请求在 Electron 主进程执行。`canvas-v2/src/engine/engine.ts` 与 `executors.ts` 不是桌面生产主路径。任何模板能力判断都必须以 `electron/canvas-run-*` 和 `electron/canvas-node-executors.ts` 为准。

### 2.2 原稿与代码的差距

| 原稿假设 | 当前事实 | 设计处理 |
|---|---|---|
| `count: 2/4` 会生成 2/4 张 | `count` 落入 `settings` 后被生产运行图丢弃；图片协议固定 `n: 1` | 删除模板 `count`，用显式并行节点表达真实请求数 |
| `durationSeconds: 6/8` 控制视频时长 | 生产契约只读取 `seconds`，否则回退 5 秒 | 模板统一写 `seconds: 'N'`，修正节点默认字段 |
| 多支路进入 Gallery 会汇总候选 | Gallery executor 只透传首个输入 | 让 Gallery 返回同一媒体类型的全部输入；禁止把它描述成人工暂停点 |
| 模板变量会先让用户填写 | App 固定 `draft: true` 且不传 `values` | 增加模板配置对话框；保留“先插入空白骨架”的次级入口 |
| 可选素材留空仍能跑 | 空 `image-input` 会被 preflight 阻塞 | 首版模板的连线素材全部设为必填；可选素材改成不同模板变体 |
| 可选空提示词支路不影响整链 | 空提示词生成节点会失败并产生 partial run | 每个存在的付费支路必须有默认提示词或必填变量 |
| 模板锁定模型即可运行 | 用户当前分组可能没有该模型 | 按能力选择当前分组模型；无兼容模型时禁用模板运行入口 |
| 预计 N 次生成等于准确费用 | 当前只能准确知道付费请求数，不能预知 quota/人民币 | 展示“最多 N 个付费请求、N 张图、M 个视频”，不伪造金额 |
| T04 是最大模板 25 节点 | 原正文实为 19 节点/24 边；T07 为 37/36 | 用展开后的真实拓扑重新计数，并做几何碰撞测试 |

### 2.3 已经可复用的底座

- 主进程 DAG、并发 2、取消、运行历史、部分失败隔离。
- 节点指纹缓存、运行全部/到节点/选中/仅变更。
- 图片生成、1–4 参考图编辑、单参考图视频生成。
- 本地资产库、账号隔离、项目工作区、`.xingcanvas` 项目包。
- 模型与分组预检、付费请求前持久化、模糊提交不自动重试。
- 模板 ID 重映射、一次撤销、禁止自动运行、来源门禁。
- renderer 无凭据、无 relay 直连，所有请求经宿主桥。

### 2.4 不能在本批承诺的能力

- `frame-extract`、TTS、mask、首尾帧、透明背景、批量矩阵、VTON、条漫拼接、PDF/animatic。
- Gallery 中途暂停、用户采纳后再继续同一次 DAG。
- 施工级结构保持、整集角色绝对一致、文字排版成品、商品实物绝对保真。
- 预计人民币或 quota；当前只有运行后的真实 quota 字段。
- 远程模板缩略图、第三方模板市场、模板分成。

## 3. 目标与非目标

### 3.1 本设计目标

- 用户从“白底图速产”等任务进入，而不是从裸节点进入。
- 模板显示行业、交付物、所需输入、兼容能力和真实最大付费请求数。
- 用户能在插入前填写文本、选择枚举、绑定本地资产。
- 模板插入后绝不自动运行，运行前仍经过现有付费预检。
- 每个模板的节点、端口、版本、变量和来源可静态验证。
- 20 套模板分批发布，每批都可独立回滚。
- 不突破当前安全边界与项目包边界。

### 3.2 明确非目标

- 不在本批新增 AI provider、模型渠道或主进程网络通道。
- 不在本批实现通用批量 `count/n`。
- 不在本批实现模板市场、账号级遥测或后端分析接口。
- 不把画布变成剪辑、排版、3D、CAD、投放或分发工具。
- 不复制调研竞品的源码、截图、模板文案或视觉资产。

## 4. 路线比较

### 路线 A：原样加入 20 套模板

优点：改动文件少，上线快。

缺点：生成数量、视频时长、Gallery、可选输入和变量表单均与文案不一致；用户会看到付费结果与承诺不符。

结论：拒绝。

### 路线 B：先实现通用 `count`，再加入 20 套

优点：模板节点少，接近原稿写法。

缺点：必须同时改变 renderer model、持久化、IPC 白名单、指纹、预检、图片服务、取消和费用语义；还需逐 provider 生产实测单 POST 多图是否可靠。

结论：不作为第 0 步。上游协议与计费完成独立验证后可单独立项。

### 路线 C：显式并行节点 + 模板基础设施

优点：每个付费请求在画布上可见；与现有缓存、排队、取消和预检完全一致；不依赖 provider 批量行为；请求数可由图自动计算。

缺点：大型模板节点数增加，布局与 Gallery 聚合必须先补齐。

结论：推荐。

## 5. 推荐架构

### 5.1 模板目录与元数据

模板不再全部堆在一个文件中：

```text
canvas-v2/src/templates/
├── catalog/
│   ├── architecture.ts
│   ├── commerce.ts
│   ├── education.ts
│   ├── entertainment.ts
│   ├── game.ts
│   ├── marketing.ts
│   ├── media.ts
│   └── index.ts
├── builtin-templates.ts
├── template-catalog.ts
├── template-types.ts
├── validate-template.ts
└── instantiate-template.ts
```

`category` 继续表示 `image | video`，新增独立 `industry`，避免破坏原有媒体类别：

```ts
export type CanvasTemplateIndustry =
  | 'story'
  | 'commerce'
  | 'architecture'
  | 'social-media'
  | 'education'
  | 'game'
  | 'marketing-film'

export interface CanvasTemplateRequirement {
  media: 'image' | 'video'
  operation: 'generate' | 'edit'
  options?: readonly ('size' | 'quality')[]
}

export interface CanvasTemplate {
  // 保留现有字段
  industry: CanvasTemplateIndustry
  deliverable: string
  disclaimer?: string
  featured?: boolean
  requirements: readonly CanvasTemplateRequirement[]
}
```

付费请求数不手写到 `description`，由拓扑计算：

```ts
export interface CanvasTemplateEstimate {
  imageRequests: number
  videoRequests: number
  paidRequests: number
}
```

一节点一结果后，估算只需统计 `image-generate`、`image-edit`、`video-generate` 节点。UI 统一渲染“最多 4 个图片请求”，避免描述与拓扑漂移。

### 5.2 模板静态校验

新增独立 validator，并以 registry 为真相源校验：

- template/node/edge/variable ID 唯一且有界。
- node type 存在，`definitionVersion` 与 registry 一致。
- `requiredNodeTypes` 与实际节点类型集合完全相等。
- edge 两端节点存在；handle 存在、方向正确、媒体类型一致。
- `cardinality: one` 不允许多入；禁止自环与 DAG 环。
- variable ID 唯一；target 节点存在；path 只允许自有普通对象字段。
- path 拒绝 `__proto__`、`prototype`、`constructor` 和凭据字段。
- select 必须有非空唯一 options，defaultValue 必须属于 options。
- asset default/value 只能是 43 字符本地资产 ID。
- 节点矩形不重叠；位置与总边界有界。新行业模板的布局测试另要求建议的 32 px 最小间距。
- 内置模板集合与 `docs/canvas-third-party.json` 的模板集合完全一致。

### 5.3 模型能力解析

模板声明操作要求，不把 `gpt-image-2` 写死为唯一可用模型。

载入时：

1. 从当前所选分组取得已配置模型。
2. 对 `image-edit` 选择第一个支持 edit 的模型。
3. 对 `image-generate` 选择第一个支持 generate 的模型。
4. 对 `video-generate` 选择第一个支持视频的模型。
5. 如果模板把 `size` 或 `quality` 声明为交付要求，只选择支持该选项的模型；找不到时模板不可用。
6. 非交付要求的 `size`/`quality` 仅在模型支持时保留，否则用该模型默认值或省略。
7. 找不到兼容模型时，模板卡显示“当前分组不可用”，不允许发起运行。

模板可声明 preferred model 作为排序偏好，但不能绕过分组实际模型列表。

### 5.4 模板选择与配置

```text
空画布“从模板开始” / 左侧模板页 / 快速插入
  → 打开 TemplateCatalog
  → 行业筛选、搜索、查看输入/交付物/请求数/免责声明
  → 打开 TemplateConfigurator
  → 填写 text/select，asset 只能选本地资产或调用原生导入
  → 校验变量和模型能力
  → instantiateTemplate(values, draft:false)
  → 一次 add-nodes 插入
  → 用户手动打开运行前检查
  → 用户确认后运行
```

为高级用户保留“先插入空白骨架”，它走 `draft:true`，按钮文案必须明确“需要在画布内补全输入”。

### 5.5 Gallery 的准确语义

本批把 Gallery 定义为“汇总同一轮多个上游节点已经产生的资产”，不是暂停点。

- Gallery executor 返回 `inputs.images`，否则 `inputs.videos`，否则 `inputs.audios`。
- Gallery、router、output 是本地轻量节点，不使用单候选 cache，避免缓存命中后丢失其余候选。
- Gallery 运行记录保存全部候选，renderer 可显示和采纳。
- Gallery 若连接下游，当前同一轮仍默认把第一项传给下游；UI 与模板文案必须说明。
- 需要“先人工选，再继续”的 T01/T13 拆成两段模板，或等独立 review-gate 设计后再发布完整版。

### 5.6 付费与错误处理

- 模板卡显示拓扑推导出的最大请求数，不显示未证实的金额。
- 运行前检查继续显示实际选中范围、最大付费请求数和阻塞项；当前 renderer 不预先查询主进程 cache，因此实际请求可能因运行时 cache 命中而减少。
- 显式并行节点由现有并发 2 排队；不修改队列上限。
- 模型不兼容、素材缺失、提示词缺失均在付费提交前阻塞。
- 单支路失败继续保持 partial run，其他支路完成。
- 取消与模糊提交继续遵守“不自动重试付费 POST”。
- 模板插入失败不修改画布；整次插入仍为一个可撤销 command。

## 6. 20 套模板的可实施修订

下表的“图/视频请求”按首次全量运行且无缓存命中计算。所有 `count` 均展开为独立节点。

| ID | 发布批次 | 修订后的真实拓扑 | 图/视频请求 | 关键约束 |
|---|---:|---|---:|---|
| T01 角色设定卡 | 4 | 第一阶段 4 个并行 generate → Gallery；转视图拆成第二模板或 review-gate 后再加 | 4 / 0 | 不宣称同轮人工选图后继续 |
| T02 分镜一致性出图 | 3 | 角色与场景均必填 → 4 个并行 edit → Gallery | 4 / 0 | 可选场景另做“单参考图版” |
| T03 镜头图生视频 | 2 | input + prompt → video → Gallery | 0 / 1 | 使用 `seconds:'8'` |
| T04 漫剧单集六镜骨架 | 4 | 每镜 prompt → 4 edits；其中固定 primary edit → video；每镜输入必填或有默认值 | 24 / 6 | 不把四候选描述成人工选定后再成片；不声称仅点 video 就不跑未缓存上游 |
| T05 六格条漫 | 4 | 每格 prompt → 4 edits → 独立 Gallery | 24 / 0 | 不承诺自动拼成长条 |
| T06 线稿上色翻新 | 1 | input + prompt → 4 edits → Gallery | 4 / 0 | 首发第四套 |
| T07 十二页绘本 | 4 | 每页 prompt → 2 edits → 独立 Gallery | 24 / 0 | 12 页都提供默认值或设必填 |
| T08 课件插图四连 | 3 | 四种完整 prompt 各连 2 generates → Gallery | 8 / 0 | 变量值必须是完整 prompt，不做字符串拼接假设 |
| T09 白底图速产 | 1 | input + prompt → 4 edits → Gallery | 4 / 0 | 保留“生成式结果需自查” |
| T10 场景图三连拍 | 3 | 三场景各 2 edits → Gallery | 6 / 0 | 场景使用完整默认 prompt |
| T11 主图规格三连 | 2 | 三尺寸各 2 edits → Gallery | 6 / 0 | 尺寸按模型能力解析 |
| T12 毛坯房变样板间 | 1 | 六风格各 2 edits → Gallery | 12 / 0 | 概念图，非施工图；纵向间距按节点高度 |
| T13 体块草模效果图 | 3 | 4 个 render 候选作为第一阶段；精修另做模板 | 4 / 0 | 不在同轮默认取首候选后精修 |
| T14 旧改立面焕新 | 3 | input + 单个完整改造 prompt → 4 edits；note 独立 | 4 / 0 | text/select 只保留一种；完成全部边 |
| T15 小红书封面底图四选 | 1 | prompt → 4 generates → Gallery | 4 / 0 | 明确不做文字排版 |
| T16 B-roll 素材包 | 3 | 三支路各 prompt → generate → video → output | 3 / 3 | 使用 `seconds:'6'`，补齐 video→output |
| T17 道具图标套系 | 2 | anchor + prompt → 4 edits → Gallery | 4 / 0 | 不承诺透明底 |
| T18 角色立绘差分 | 2 | 固定一致性 prompt + 用户差分 prompt → 4 edits → Gallery | 4 / 0 | 利用 `in:text many` 拼接，不覆盖固定前缀 |
| T19 信息流 AB 素材 | 3 | A/B 各 prompt → generate → video → output | 2 / 2 | 删除矛盾 count，补齐输出边 |
| T20 分镜动态预演 | 2 | input + 完整运镜 prompt → video → Gallery | 0 / 1 | 使用 `seconds:'5'`；不做首尾帧 |

原三套模板保留 ID 以兼容现有入口，但修正无效字段与描述。

## 7. 发布批次

### 批次 0：基础语义

- 模板 validator 与 provenance 集合门禁。
- `seconds` 统一与旧三模板修正。
- Gallery 多输入汇总和本地流节点 cache 修正。
- 模板目录、行业元数据、请求数推导。
- 模板目录 UI 与变量配置器。

### 批次 1：四套首发

- T09 白底图速产。
- T15 小红书封面底图四选。
- T12 毛坯房变样板间。
- T06 线稿上色翻新。
- 对应行业提示词预设。

选择 T06 替代原首发 T01，是因为 T01 的“先挑角色再继续做转视图”依赖当前不存在的人工执行闸门。

### 批次 2：低风险单链

- T03、T11、T17、T18、T20。

### 批次 3：需拓扑修订的中型模板

- T02、T08、T10、T13、T14、T16、T19。

### 批次 4：大型生产骨架

- T01 修订版、T04、T05、T07。
- 批次 4 进入开发前，批次 1 至少完成一轮真实用户试用并确认大型模板的可读性与请求量可接受。

## 8. 测试策略

### 8.1 纯函数与契约测试

- 模板 schema、端口、变量、DAG、碰撞、来源集合。
- config → WorkflowNodeData → CanvasRunGraph 投影。
- 当前分组模型能力选择与不可用状态。
- 拓扑推导的请求数与实际付费节点数相等。
- Gallery 多输入、缓存策略、候选投影。
- 预检的素材缺失、模型缺失、请求数和缓存命中。

### 8.2 Electron 主进程测试

- 多参考图顺序与 1–4 上限。
- 视频 `seconds`、尺寸、图片资产精确传递。
- 多分支仍受并发 2 限制。
- 部分失败不取消独立支路。
- 模糊付费请求不自动重试。
- renderer 契约仍不接受凭据或未知字段。

### 8.3 真实 UI 与视觉测试

- 960×620、1366×768、1590×875、3840×2160。
- 行业筛选、搜索、键盘焦点、配置器校验、资产选择、取消和插入。
- 空画布、已有大型画布下方插入、一次撤销。
- T12、T04、T07 初始无节点重叠，fit view 后可定位支路。
- 自动测试只用 fixture/mock；真实 relay 仅做人工真机验收。

### 8.4 必跑门禁

```text
npm run typecheck
npm run test:canvas
npm test
npm run canvas:prepare
npm run test:canvas:visual
git diff --check
```

## 9. 度量与证据边界

行业蓝图中的市场规模、竞品收入、融资、模型效果与行业成本是调研引用，不是本仓库已验证事实。对外使用前应单独核验来源。

本批不擅自增加账号级遥测。可用的首轮验证方式是：

- 5–10 名试用用户的任务完成率。
- 每套模板从打开到通过 preflight 的时间。
- 阻塞原因：缺素材、缺模型、提示词、余额或用户取消。
- 首次全量运行的成功/partial/failed 结果。
- 用户是否继续使用“仅变更”或“运行到节点”。
- 用户是否能把输出带入剪映、稿定、CSP、PPT 或其他下游工具完成交付。

若要收集线上模板打开次数与 7 日生成量，必须先定义后端事件契约、隐私说明、采样和退出机制，作为独立项目评审。

## 10. 完成标准

- 模板目录至少能展示并配置批次 1 的四套模板。
- 四套模板每个付费请求都由一个可见节点表示，UI 数字与实际 preflight 一致。
- 模板不自动运行；用户确认前没有付费请求。
- 当前分组没有兼容模型时不会提交请求。
- 所有内置模板通过完整 registry、端口、变量、布局和 provenance 校验。
- Gallery 能显示多个并行支路资产，但文案不承诺人工暂停后继续。
- 原有三套模板仍能插入并运行，视频时长字段不再静默失效。
- 安全边界、项目包、账号隔离与模糊提交保护无回归。
- Windows 与 macOS 的既有质量门禁均不因模板包回归。

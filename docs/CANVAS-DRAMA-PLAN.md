# 无限画布 · 漫剧 / 短剧生产实施计划

> 写于 2026-08-21。目标是把「剧本 → 资产 → 分镜静帧」做成可交付的画布能力，而不是再造一套生成后端。
>
> 与代码冲突时以代码为准。自动化测试一律 mock，不对 `xm.solov.cc` 发真实请求。

---

## 0. 一句话

星芒已有图像 / 视频节点和 `canvas-host`。缺的是**剧集语义层**：剧本解析、三种可复用资产、分镜编译出生图提示词。真正花钱的生成继续走现有节点。

```text
[剧本]──抽取──▶[角色]──多视图定妆──▶[角色资产]
              ├──────────▶[场景资产]
              └──────────▶[道具资产]
                              │ 参考图边
[风格包]──注入──▶[分镜1]──hero still──▶[视频1]──尾帧──▶[分镜2]
```

资产是库节点（可复用）。分镜是时间序节点。视频时间线、配音、剪辑不在第一刀。

---

## 1. 已有基础（不要重做）

| 能力 | 位置 | 用法 |
|---|---|---|
| 图像 / 视频生成 | `image-generate` / `video-generate` + 主进程执行器 | 分镜编译完的 prompt 和参考图喂给它们 |
| 提示词节点 | `prompt` | 可承接编译结果，或继续给人手改 |
| 素材库 / 参考图 | `image-input`、素材栏、`editImage` 1–4 张参考图 | 资产锁定妆图走这里 |
| 候选画廊 | `gallery` | 一镜多 take，人选英雄版 |
| 视频抽帧 | `frame-extract` | 后段「尾帧 → 下镜首帧」复用它 |
| 角色多视图提示词 | `canvas-v2/src/library/character-sheet-prompt.ts` | **已落地**：上 1/3 头像三视图 + 下半身无头三视图 + 外貌 + 风格 |
| 角色设定卡模板 | `xingmang-drama-character-sheet` | 已改用上述版式，尺寸 `1536x1152` |
| 六镜骨架模板 | `xingmang-drama-episode-6` | 轻量生产线，语义仍弱，本计划补语义后可升级 |
| 文字分组 / 默认聊天模型 | 生成配置 `mediaGroups.text` + `textModel` | 剧本解析走主进程聊天，用这个分组和模型 |

### 安全红线（整条计划必须遵守）

- **I15**：画布渲染层不能 `fetch`，摸不到 API Key。解析 / 编译若要用 LLM，只许主进程（`ai-chat-service` / 现有 `canvas-host` 通道）。
- 新能力先问：画布被投毒后这个能力能干什么？文件路径仍只能走对话框或现有资产 ID。
- 工作流只存 `assetId`、有界文本、枚举字段；不存 Key、绝对路径、远程 URL。
- 新 IPC 通道必须走 `canvas-contract` + preload 字面量副本 + 测试钉死顺序（T1 / I4 / I7）。
- 用户可见错误中文；测试名英文；无分号、单引号、顶层 `function`。

---

## 2. 产品范围

### 第一刀（本计划必须做完才算「能用」）

1. 项目级圣经（风格锚、色卡、负向库）。
2. 三种资产：角色 / 场景 / 道具；每条有稳定 ID、描述、参考图、硬规则。
3. 剧本 → 四表 JSON（角色 / 场景 / 道具 / 镜头），人确认后再落成节点。
4. 角色定妆默认用已落地的多视图版式；人改外貌描述即可换角。
5. 分镜节点编译生图提示词：动作 / 构图写在分镜里，外貌从资产边注入，禁止把脸再写进分镜 prompt。
6. 定妆未封板时，下游强制分镜不出图（闸）。

### 明确不做（第一刀）

- 从零自动编剧成长篇（可后做「续写」；导入 / 粘贴剧本优先）。
- 视频运镜方言、尾帧连续自动接线、完整时间线 / 剪映导出。
- 画布上训 LoRA、FaceID、IP-Adapter、ComfyUI。
- 一句话 Media Agent 自动铺完整张图并开跑（最多「建议节点，人确认」）。
- 配音、口型、字幕、多轨剪辑。
- Work-Fisher 31 种图型全集（先做角色多视图 + 场景底板 + 分镜关键帧 3 种）。

### 对照业内该抄 / 不抄

| 抄 | 来源 | 不抄 |
|---|---|---|
| 三张资产表 + 分镜↔资产多对多 | [Koma](https://github.com/M-JYuan/Koma) | 完整 NLE / 剪映导出 |
| 风格 Skill + 资产必须挂 ID | [Toonflow](https://github.com/HBAI-Ltd/Toonflow-app) | 三层 Agent 自动导剧 |
| `hardRules`、服装可后拆 | [Instant Drama Magician](https://github.com/yanshekki/instant-drama-magician) | 漫画书 / Key Art 整本 |
| `Frame → Take[] → heroTakeId` | [Inline Studio](https://github.com/inlineresearch/Inline-Studio) | 画布训 LoRA |
| 六段式静帧 prompt、四表解析、人工闸 | 本地 `无限画布资源学习/.../image-prompt-engine.md` | 视频运镜翻译器（技能自己也不做） |

---

## 3. 目标数据模型

全部作为工作流节点 `data` / `settings` 的**可选字段**落地，缺省 = 旧行为。schema 与 `electron/canvas-project-package.ts` 的 `assertAllowedKeys` 必须同步加白名单，否则自动保存会失败。

### 3.1 项目圣经（一个项目一份）

节点类型建议：`drama-bible`（或先用 `group` + 约定 settings，第一刀用独立节点更干净）。

```ts
interface DramaBibleData {
  title?: string
  worldTone?: string          // 一句话世界观 + 基调
  stylePrompt?: string        // 默认「3D漫剧写实厚涂风。」
  aspectRatio?: '16:9' | '9:16' | '1:1'
  colorLocks?: Array<{ entity: string; hex?: string; morphology?: string; rule: string }>
  genreAvoid?: string[]       // 题材级负向
  defaultImageSize?: string   // 分镜静帧默认尺寸
}
```

圣经文本注入**每一条**分镜编译结果的风格段和 Avoid 段。不单独出网。

### 3.2 资产（三种节点，同一套字段形状）

```ts
type DramaAssetKind = 'character' | 'scene' | 'prop'

interface DramaAssetData {
  assetKind: DramaAssetKind
  name: string                // 显示名，可改
  elementId: string           // 稳定 ID，解析表与分镜引用它；改名不改 ID
  appearance: string          // 外貌 / 环境 / 形态。角色用「脸发服一句」
  hardRules?: string          // 必须 / 禁止，优先级高于 appearance
  promptTags?: string         // 短标签，注入每镜
  sheetPrompt?: string        // 编译后的定妆 / 底板 prompt（可手改）
  locked?: boolean            // 封板。true 之前下游分镜拒绝出图
  result?: AssetRef           // 当前英雄参考图
}
```

- **角色定妆图**：`composeCharacterSheetPrompt({ appearance, style: bible.stylePrompt })`。版式锁在 `character-sheet-prompt.ts`，用户通常只改 `appearance`。
- **场景底板**：纯环境、无人、锁结构与色调。另写 `composeSceneSheetPrompt`（第一刀做最小版）。
- **道具图**：白底或灰底单物 + 形态命门。另写 `composePropSheetPrompt`（第一刀做最小版）。
- 服装变体第一刀做成角色 `derive` 文本（换装描述），不拆独立 Costume 表。

### 3.3 四表 JSON（解析器唯一合同）

主进程 LLM 必须吐这个形状；渲染层只展示和落节点，不自己「理解」剧本。

```ts
interface DramaParseTables {
  characters: Array<{
    elementId: string
    name: string
    appearance: string
    powerRelation?: string
    colorLock?: string
  }>
  scenes: Array<{
    elementId: string
    name: string
    environment: string
    tone?: string
    needsBlockingBoard?: boolean
  }>
  props: Array<{
    elementId: string
    name: string
    morphology: string
    countLock?: string
  }>
  shots: Array<{
    shotId: string
    timeRange?: string
    sceneId: string
    characterIds: string[]
    propIds?: string[]
    action: string
    framing: string          // 大特写|中景|越肩…
    camera?: string          // 极缓推|固定|微移
    emotion?: string
    dialogue?: string
  }>
}
```

校验（纯函数，`canvas-v2/src/library/drama-parse.ts` + 主进程各一份或共享无 Node 依赖模块）：

- 每表 `elementId` / `shotId` 非空、唯一、长度 ≤ 64、无控制字符。
- `shots[].sceneId` / `characterIds` 必须能在表里找到。
- 字符串字段有上限（名称 64、外貌 2000、动作 2000），超长截断并 warning。
- 角色 / 场景 / 道具 / 镜头条数上限：32 / 16 / 32 / 80。超出拒绝并中文报错。

样例输入：`无限画布资源学习/精准控制所有分镜/剧本/剧本.txt`（《丹引》时间码语法）。解析器要能吃这种，也要能吃纯对白剧本（镜头字段可空，规划阶段再补）。

### 3.4 分镜节点

```ts
interface DramaShotData {
  shotId: string
  beat?: string
  framing?: string
  camera?: string
  emotion?: string
  dialogue?: string
  action: string             // 只写动作 / 构图 / 谁在哪做什么，不写脸
  compiledImagePrompt?: string
  compiledVideoPrompt?: string  // 第一刀可空，只留字段
  gate?: 'blocked' | 'ready' | 'stale'
}
```

连线语义（用现有端口，不新开第二种绝对路径）：

| 边 | 含义 |
|---|---|
| `drama-bible.out:text` → `drama-shot.in:text` | 注入风格 / Avoid |
| `drama-character.out:image` → `drama-shot.in:images` | 角色参考图 |
| `drama-scene.out:image` → `drama-shot.in:images` | 场景参考图 |
| `drama-prop.out:image` → `drama-shot.in:images` | 道具参考图 |
| `drama-shot.out:text` → `image-generate.in:text` | 编译后的生图 prompt |
| `drama-shot.out:image`（透传参考图）→ `image-generate.in:images` | 参考图原样下送 |

分镜节点**自己不出图**。它是编译器 + 参考图收集器。出图仍是 `image-generate`。

---

## 4. 提示词编译（静帧）

三层拼接，顺序固定：

```text
1. 版式 / 图型骨架     （角色多视图已有；分镜关键帧另写一版短骨架）
2. 分镜动作与构图       （只来自 shot.action / framing / camera）
3. 从边注入的资产外貌   （appearance + promptTags + hardRules）
4. 圣经 stylePrompt + genreAvoid
```

铁律：

- 分镜 `action` 里出现「长发 / 圆眼 / 红衣」这类外貌词时，编译器**不删除用户原文**，但 UI 提示「外貌请写在角色资产上」。第一刀不做 NLP 剥离。
- 多角色：按连线顺序标注「Image 1 仅锁 A 的脸，不提供姿势；Image 2 仅锁 B…」，并在 Avoid 加「faces swapped or merged」。
- 中英对照第一刀只出中文（模型吃中文即可）。英文对照放到第二刀。
- 角色资产图继续用 `composeCharacterSheetPrompt`，不要改回「单张正面立绘」。

分镜关键帧骨架（最小可用，放 `canvas-v2/src/library/shot-frame-prompt.ts`）：

```text
单张剧情关键帧，不是设定图。
景别：{framing}。运镜感觉：{camera}。
画面里谁在哪做什么：{action}。
身份与服装只以参考图为准，prompt 不重写五官。
与项目风格一致。不生成字幕、片名、水印。
```

---

## 5. 节点与执行分工

| 节点 `type` | 是否新类型 | 执行器 | 说明 |
|---|---|---|---|
| `drama-bible` | 新 | 无（structural 或透传 text） | 项目常量 |
| `drama-script` | 新 | 无，只存文本 | 粘贴 / 导入剧本 |
| `drama-parse` | 新 | 主进程 LLM | 入剧本，出四表 JSON（text） |
| `drama-character` / `drama-scene` / `drama-prop` | 新 | 本地编译 + 下游 image-generate | 资产卡；锁定妆走现有出图 |
| `drama-shot` | 新 | 本地纯函数编译 | 收集边、拼 prompt、判闸 |
| `image-generate` / `gallery` | 现有 | 现有 | 不要为漫剧再写一套出图 |

### 主进程通道

优先**复用**现有聊天能力，避免新 `canvas-host` 通道（T1 顺序敏感）。

方案 A（推荐，第一刀）：`drama-parse` 的 executor 走已有 run 引擎，在 `electron/canvas-node-executors.ts` 里调 `ai-chat-service` 一次非流式 completion。画布不新增 IPC。

方案 B：若 run 引擎不便挂聊天，再加 `canvas-host:complete-text`，必须同步改 `canvas-contract.ts`、`canvas-preload.ts`、测试。

解析 system prompt 放 `electron/drama-parse-prompt.ts`（或 canvas-v2 无 Node 依赖模块再被主进程复制——不要让 `ipc-contract` 带 Node）。要求模型**只输出 JSON**，温度低，超长截断。

---

## 6. UI / 交互

### 6.1 落节点（人确认闸）

1. 用户在 `drama-script` 粘贴剧本，运行 `drama-parse`。
2. 弹出确认板（用现有 Dialog / Inspector，不新开路由）：四张表可勾选、可改名、可删行。
3. 点「生成资产与分镜」才 `add-nodes`：圣经（若无）+ 资产节点 + 分镜节点 + 连线。坐标按网格排布（资产一列，分镜按镜号向下）。
4. **绝不自动运行出图。**

### 6.2 资产卡

- 显示名、外貌、硬规则、封板开关。
- 按钮「编译定妆提示词」只改 `sheetPrompt`，不请求网络。
- 下游接 `image-generate`（尺寸角色默认 `1536x1152`）。出图后把英雄图写回资产 `result`。
- 未封板：分镜编译结果带 `gate: 'blocked'`，运行预检中文报错：「请先封板角色「虞晚」的定妆图」。

### 6.3 分镜卡

- 镜号、景别、动作、台词。
- 只读展示「将注入的资产」列表（从入边解析）。
- 「编译生图提示词」写入 `compiledImagePrompt` 并送到 `out:text`。
- 下游 `image-generate` 默认用项目圣经比例。

### 6.4 节点库

新分组「漫剧」：圣经、剧本、解析、角色、场景、道具、分镜。不要塞进「生成」和现有图像节点混排。

---

## 7. 分阶段实施

每阶段一个可合并的工作单元。做完必须 `npm run typecheck` + 相关 vitest 绿。改画布后 `npm run canvas:prepare`。改 `mediaGroups` / 节点 data 白名单时同步 electron 包校验。

### P0 · 已完成（记录，勿回退）

- [x] 角色多视图版式：`character-sheet-prompt.ts`（上 1/3 头 + 下无头三视图）。
- [x] 预设 `xingmang-story-character-card`、模板 `xingmang-drama-character-sheet`。
- [x] 生成配置：生图 / 视频 / 文字分组 + 默认模型；旧项目补 Gemini；主进程允许 `text` / `*Model` 字段。

### P1 · 数据与纯函数（先写测试再接线）

**交付**

- [x] `canvas-v2/src/library/drama-model.ts`：圣经 / 资产 / 四表 / 分镜类型。
- [x] `canvas-v2/src/library/drama-parse.ts`：校验四表、截断、中文错误。
- [x] `canvas-v2/src/library/shot-frame-prompt.ts`：分镜关键帧骨架。
- [x] `canvas-v2/src/library/scene-sheet-prompt.ts` / `prop-sheet-prompt.ts`：最小底板。
- [x] `canvas-v2/src/library/drama-compile.ts`：`compileShotImagePrompt(bible, assets, shot)`；`compileCharacterSheetPrompt` 只包装现有函数。
- [x] `canvas-v2/src/library/drama-gate.ts`：任一引用资产 `locked !== true` → `blocked`。

**测试（英文 it）**

- 《丹引》节选 fixture → 手写四表通过校验。
- 缺 `sceneId` / 超条数 / 空 ID 失败。
- 编译结果含动作、不含把角色 appearance 再复述成「请长一张新脸」；含 hardRules 与 style。
- 未封板 → blocked；全封板 → ready。

**验收**：不改 UI 也能在 Node 里跑完上述测试。

### P2 · 节点定义与落盘

**交付**

- [x] `builtin-node-definitions.ts` 增加 7 个类型（圣经、剧本、解析、三角色资产、分镜）。
- [x] `hiddenLibraryNodeTypes` 不要藏它们。
- [x] `NodeLibrary` 增加「漫剧」分类。
- [x] `workflow-schema.ts` / `workflow-sanitizer.ts` / `electron/canvas-project-package.ts` 为新 `data` 字段加白名单。
- [x] 节点渲染：资产卡显示缩略图 + 封板；分镜卡显示镜号和闸状态。先简，不做到 Work-Fisher 31 图型。

**验收**

- 空画布能拖出三种资产和分镜，保存 / 重开不丢字段。
- 导出项目包不含 Key、路径。
- 旧项目打开不受影响。

### P3 · 解析（主进程 LLM）+ 确认落图

**交付**

- [x] 解析 system prompt + JSON 解析（失败重试 1 次，仍失败中文报错）。
- [x] `drama-parse` 执行器走方案 A。
- [x] 确认板：勾选后 `add-nodes` + 自动连圣经 / 资产 → 分镜 →（只连线，不创建出图节点也可；或每个分镜后跟一个未运行的 `image-generate`，由产品定，推荐**先不自动建出图节点**，避免一次铺出几十个付费节点吓到用户）。
- [x] 预检：未解析成功不能落图。

**验收**

- mock 聊天返回《丹引》四表，确认后画布出现虞晚、谢凛、暖阁、血丹、若干分镜。
- 真实账号手测：文字分组选 Gemini，默认模型 `gemini-3.7-flash`（或账号实际可用的聊天模型）。
- 点运行解析会消耗文字额度；点确认**不**消耗生图额度。

### P4 · 定妆与分镜出图（接现有生成节点）

**交付**

- [x] 资产卡「编译定妆提示词」+ 一键在右侧放一个 `image-generate`（可选手搓）。
- [x] 分镜「编译生图提示词」写入 `out:text`；闸 blocked 时 run-preflight 拦下。
- [x] 出图成功后，资产节点把 gallery 英雄图写回 `result`（复用现有 adopt 路径，不要新 IPC）。
- [x] 升级模板：`xingmang-drama-character-sheet` 已对齐；新增「剧本落资产」模板只含 script + parse，不含六镜视频。

**验收**

- 角色外貌改成另一段描述，编译结果中间段变、版式段不变。
- 未封板跑分镜出图 → 中文预检失败。
- 封板后分镜编译含参考图职责声明；接上 `image-generate` 能跑（手测）。

### P5 · 闸与 stale（仍不做时间线）

**交付**

- [x] 资产参考图变更 → 已编译分镜标 `stale`，要求重编译。
- [x] Inspector 列出 blocked / stale 分镜。
- [x] `locked` 写入持久化。

**验收**：改角色外貌后，旧分镜 prompt 不再假装有效。

### P6 · 后置（单独排期，本文只留接口）

- 上一镜 `frame-extract` 尾帧 → 下一镜参考图。
- `compiledVideoPrompt` 厂商方言（Grok / MiniMax）。
- 一镜多 take 与 `heroTakeId`（gallery 已能选，缺的是分镜级指针）。
- Work-Fisher 图型 01 / 23 / 31（站位、色卡、正反打关系板）。
- 剧本续写节点（同一文字分组）。

---

## 8. 建议文件清单（P1–P4）

```text
canvas-v2/src/library/drama-model.ts
canvas-v2/src/library/drama-parse.ts
canvas-v2/src/library/drama-parse.test.ts
canvas-v2/src/library/drama-compile.ts
canvas-v2/src/library/drama-compile.test.ts
canvas-v2/src/library/drama-gate.ts
canvas-v2/src/library/shot-frame-prompt.ts
canvas-v2/src/library/scene-sheet-prompt.ts
canvas-v2/src/library/prop-sheet-prompt.ts
canvas-v2/src/library/character-sheet-prompt.ts      # 已有，P4 只调用
electron/drama-parse-prompt.ts                      # 或与 library 共享无 Node 模块
electron/canvas-node-executors.ts                   # 增加 parse 分支
canvas-v2/src/domain/builtin-node-definitions.ts
canvas-v2/src/nodes/WorkflowNodes.tsx               # 资产卡 / 分镜卡简渲染
canvas-v2/src/components/DramaParseConfirm.tsx      # 确认板，纯回调不 fetch
canvas-v2/src/persistence/workflow-schema.ts
canvas-v2/src/persistence/workflow-sanitizer.ts
electron/canvas-project-package.ts
canvas-v2/src/runtime/run-preflight.ts              # 闸错误
docs/CANVAS-DRAMA-PLAN.md                           # 本文
```

禁止改 `dist-canvas/`。禁止在 `canvas-v2` 里出现 `Authorization` / `Bearer` / `.apiKey`。

---

## 9. 验证清单

每阶段结束：

```bash
npm run typecheck
npm run test:canvas
# 若动了 electron 白名单 / 执行器
npx vitest run electron/canvas-project-package.test.ts electron/canvas-node-executors.test.ts
npm run canvas:prepare
```

手测（P3/P4）：

1. 重启整个应用后再开画布（主进程不热更新）。
2. 生成配置：生图分组 + GPT Image 2；文字分组 Gemini + 可用聊天模型。
3. 粘贴《丹引》前 3 镜 → 解析 → 确认 → 只出现资产和分镜，不自动出图。
4. 编译虞晚定妆提示词，确认仍是「上三头 / 下无头三视图」+ 她的外貌 + 圣经风格。
5. 出一张定妆图，封板，再编译第一镜生图提示词，接图像节点手动跑。
6. 未封板直接跑分镜出图应被预检拦住。
7. 保存项目、关掉画布重开，四表字段还在；自动保存无「未知或敏感字段」。

---

## 10. 风险与决策

| 风险 | 处理 |
|---|---|
| 解析 JSON 不稳定 | 系统提示锁 schema；失败重试 1 次；仍失败展示原文尾 300 字（已脱敏） |
| 一次落 80 个出图节点 | P3 默认只落资产 + 分镜，出图节点用户自己拖 |
| 保存再次被 electron 拒 | 任何新字段先改 package 白名单再改渲染层 |
| 聊天模型把外貌写进每镜 | 编译器以资产字段为准拼接；分镜框 label 写明「只写动作」 |
| 与现有六镜模板冲突 | 旧模板保留；新模板另 id，不改用户已存项目 |
| 想「自动成片」 | 拒绝做到第一刀。Agent 若做，只允许建议节点 |

**默认产品决策（已拍板，改需明示）**

1. 角色资产图版式 = 已落地的上下分栏多视图，不改回单张立绘。
2. 默认风格 = `3D漫剧写实厚涂风。`，圣经可覆盖。
3. 解析用文字分组默认模型，生图用生图分组默认模型。
4. 先静帧、后视频；视频是 P6。
5. 人确认之前不改画布图。

---

## 11. 推荐开工顺序（给下一个 agent）

1. 读本文第 3、4、7 节和 `CLAUDE.md` I15 / T13。
2. 从 **P1 纯函数**开始，fixture 用《丹引》前两镜。
3. P2 节点 + 白名单，保证保存。
4. P3 解析 + 确认板。
5. P4 接到现有 `image-generate` 和 `character-sheet-prompt.ts`。
6. 不要顺手做 P6，不要引入新状态库，不要在画布里 `fetch`。

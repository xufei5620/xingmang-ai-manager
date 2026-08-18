# 画布行业模板包 · 第 0 步落地设计稿(20 套)

> 来源:2026-08-18 无限画布行业适配调查(11 个联网调研代理,覆盖 AI 漫剧/漫画/电商/建筑/短视频/游戏/广告/影视/绘本/产品设计 + 跨行业垂直化模式)。调查的核心结论:**画布是留存件,模板是获客件**;现有 3 套内置模板不足以承载任何行业,第 0 步是把模板供给扩到 20 套「任务命名」模板——全部用现有节点与 gpt-image-2 / grok-imagine-video 能力拼出,**不等任何新执行器与新模型**。
>
> 本文是可直接照抄进 `canvas-v2/src/templates/builtin-templates.ts` 的节点链设计稿。结构与字段名均已对照 `template-types.ts` / `builtin-templates.ts` / `models.ts` / `model.ts` 在 `main@6e38818` 的实态核实。

---

## 0. 设计规范(全部模板共同遵守)

1. **任务命名法**(照抄 Freepik Spaces 已验证的方法论):模板名 = 用户要交付的任务(「毛坯房秒变样板间」),不是功能描述(「图生图示例」)。description 第二句写清一轮消耗:「跑一次约 N 次图像生成」。
2. **绝不自动运行**:`TemplateInstance.autoRun: false` 是类型级钉死的,模板落位后由用户手动点运行——付费安全底线,不许绕。
3. **provenance 一律 `{ kind: 'xingmang-original' }`**:门禁(`verify-canvas-provenance.test.cjs` 与 `instantiate-template.ts` 的 validateTemplate)双重强制。本文全部模板为自产设计,无第三方来源。
4. **图像模型默认 `gpt-image-2` + `quality: 'low'`**:即梦档还是 v21(不支持改图、不支持尺寸),所有含 image-edit 的链一律锁 gpt-image-2;quality 必须显式(auto 有 35 倍费用陷阱,见 `docs/RECON-image-generation.md`)。待 relay 接入 Seedream 4.x / Nano Banana 后,全局把默认模型换掉即可(模板 version+1)。
5. **抽卡惯例 `count: 4`**:与现有三套模板一致;单张出图场景(细化/修字)用 `count: 2` 控费。
6. **id 命名**:模板 id `xingmang-<行业缩写>-<slug>`;节点 id 用语义短词;多支路用 `-1/-2/-3` 后缀;边 id `<source>-<target>`。
7. **坐标网格**:列 x = 40 / 360 / 680 / 990 / 1300,行距 y = 220(与现有模板一致);多支路按行铺开。
8. **变量规范**:每个变量只打一个 target(`instantiate-template.ts` 的 setPath 语义);跨支路共用的「主题」类输入,用多个变量各打各的节点,label 相同加序号。`select` 类型用 `options` 枚举。
9. **上限意识**:校验器限 nodes ≤ 100、edges ≤ 400,本文最大的一套(漫剧六镜骨架)25 节点 / 30 边,余量充足。

### 实现前必核的一个风险点

现有模板的 `config` 键(`count` / `durationSeconds` / `prompt`)如何合入节点 `defaultData`,由 `domain/node-registry.ts` 的 `create()` 决定;而节点运行态读的是 `data.seconds`(字符串 '1'-'15',`engine/executors.ts:147` 同时兼容 `settings.durationSeconds`)。**批量写 20 套之前,先用任意一套含 `size`/`quality`/`model` config 的模板做一次落位实测**,确认这三个键能进 `WorkflowNodeData` 同名字段(`model.ts:45-54`);若 registry 不透传未知 config 键,先补 defaultData 合并逻辑再批量——这是本计划唯一的实现不确定点,其余全部是既有能力的编排。

### 与 #89 的衔接

`instantiate-template.ts` 的 `setPath` 不拒 `__proto__`(#89 第 ⑪ 条)。本批模板全部自产、path 全部平铺字段,今天不可利用;但**建议随本批模板落地顺手修掉**(segment 校验追加拒绝 `__proto__`/`prototype`/`constructor`),因为模板数量扩大 7 倍后这条纵深的价值同步上升。

---

## 1. 总表

| # | 模板 | 行业(梯队) | 节点链骨架 | 一轮消耗* | 变量数 |
|---|---|---|---|---|---|
| T01 | 角色设定卡 | 漫剧/漫画/绘本(T1) | prompt→generate→gallery→edit→gallery→output | 4+4 图 | 2 |
| T02 | 分镜一致性出图 | 漫剧(T1) | 2×input+prompt→edit→gallery→output | 4 图 | 3 |
| T03 | 镜头图生视频 | 漫剧(T1) | input+prompt→video→gallery→output | 1 视频 | 2 |
| T04 | 漫剧单集六镜骨架 | 漫剧(T1) | input+6×(prompt→edit→video) | 24 图+6 视频 | 7 |
| T05 | 六格不崩脸条漫 | 漫画(T2) | input+6×(prompt→edit→gallery)→output | 24 图 | 7 |
| T06 | 线稿上色翻新 | 漫画(T2) | input+prompt→edit→gallery→output | 4 图 | 2 |
| T07 | 十二页绘本流水线 | 绘本(T2) | input+12×(prompt→edit→gallery) | 24 图 | 13 |
| T08 | 课件插图四连 | 教育(T2) | 4×(prompt→generate)→gallery | 8 图 | 4 |
| T09 | 白底图速产 | 电商(T1) | input+prompt→edit→gallery→output | 4 图 | 2 |
| T10 | 场景图三连拍 | 电商(T1) | input+3×(prompt→edit)→gallery→output | 6 图 | 4 |
| T11 | 主图规格三连 | 电商(T1) | input+prompt→3×edit(三尺寸)→各 gallery | 6 图 | 2 |
| T12 | 毛坯房秒变样板间 | 家装(T1) | input+6×(prompt→edit)→gallery→output | 12 图 | 7 |
| T13 | 体块草模→方案效果图 | 建筑(T1) | input+prompt→edit→gallery→edit→output | 4+2 图 | 3 |
| T14 | 旧改立面焕新对比 | 建筑(T1) | input+prompt(select)→edit→gallery+note | 4 图 | 3 |
| T15 | 小红书封面四连拍 | 自媒体(T1) | prompt→generate(3:4)→gallery→output | 4 图 | 1 |
| T16 | 口播 B-roll 素材包 | 自媒体(T1) | 3×(prompt→generate→video) | 3 图+3 视频 | 3 |
| T17 | 道具图标套系 | 游戏(T2) | input+prompt→edit→gallery→output | 4 图 | 2 |
| T18 | 角色立绘差分工厂 | 游戏(T2) | input+prompt(select+text)→edit→gallery→output | 4 图 | 3 |
| T19 | 信息流 AB 素材产线 | 广告(T2) | 2×(prompt→generate→video) | 2 图+2 视频 | 2 |
| T20 | 分镜帧转动态预演 | 影视(T2) | input+prompt(select 运镜)→video→gallery→output | 1 视频 | 2 |

\* 按默认 count 计的图像/视频调用次数;图像默认 gpt-image-2 quality low。

**第二批候补**(依赖蓝图第 1/2 步能力,不在本批):虚拟试穿(需可灵试穿渠道)、三镜连拍首尾帧衔接(需 frame-extract)、有声绘本/漫剧配音(需 TTS 执行器)、CMF 八连变体与电商 SKU 矩阵(需批量矩阵节点)、透明底图标直出(需 background 参数透传——这个是参数级,可提前)、节日促销海报直出与账号人设视觉锤(等中文文字更强的 Seedream 接入后一起上)、商品动图引流 v2(现有 `xingmang-product-video` 的 9:16 行业化改版,随视频多模型接入一起做)。

---

## 2. 逐套规格

> 记法约定:节点表列出 `id / type / config`;position 按第 0 节网格,支路 i 的 y = 基准 + 220×(i-1)。边一律写 `source(out:类型) → target(in:类型)`。变量表的 target 写 `节点id.字段`。

### T01 角色设定卡 `xingmang-drama-character-sheet`

- **行业**:漫剧/漫画/绘本通用第一步。**目标用户**:全部叙事类创作者。**卖点**:一次定稿全剧复用,按行业规范(白底、≥1024)建卡;定稿节点走指纹缓存永不重复扣费。
- **节点**:
  - `brief` / prompt / `{ prompt: '' }`
  - `generate` / image-generate / `{ count: 4, model: 'gpt-image-2', quality: 'low', size: '1024x1024' }`
  - `pick` / gallery / `{}`
  - `variant-brief` / prompt / `{ prompt: '保持角色长相、发型、服装完全一致,输出同一角色的侧面与背面视图,纯白背景' }`
  - `variants` / image-edit / `{ count: 4, model: 'gpt-image-2', quality: 'low', size: '1024x1024' }`
  - `pick-2` / gallery / `{}`
  - `output` / output / `{}`
- **边**:`brief(out:text)→generate(in:text)`;`generate(out:image)→pick(in:images)`;`pick(out:image)→variants(in:images)`;`variant-brief(out:text)→variants(in:text)`;`variants(out:image)→pick-2(in:images)`;`pick-2(out:image)→output(in:image)`
- **变量**:`character`(text, 必填, 「角色设定:姓名/年龄/画风/发型/服装,建议注明"纯白背景 全身立绘"」→ `brief.prompt`);`variant`(text, 选填, 默认为上面的转视角话术 → `variant-brief.prompt`)
- **验收**:定稿图能被后续模板作为 image-input 资产引用;改 variant 提示词只重跑 variants 支路。

### T02 分镜一致性出图 `xingmang-drama-shot-frame`

- **行业**:漫剧。**目标用户**:分镜师/AI 美术。**卖点**:角色卡+场景参考双图压崩脸,竖屏 2:3 直出;「仅变更」重跑单镜。
- **节点**:
  - `character` / image-input / `{}`(x40,y60)
  - `scene` / image-input / `{}`(x40,y280)
  - `shot` / prompt / `{ prompt: '' }`(x40,y500)
  - `edit` / image-edit / `{ count: 4, model: 'gpt-image-2', quality: 'low', size: '1024x1536' }`
  - `pick` / gallery;`output` / output
- **边**:`character(out:image)→edit(in:images)`;`scene(out:image)→edit(in:images)`;`shot(out:text)→edit(in:text)`;`edit(out:image)→pick(in:images)`;`pick(out:image)→output(in:image)`
- **变量**:`character`(asset, 必填 → `character.assetId`);`scene`(asset, 选填 → `scene.assetId`);`shot`(text, 必填, 「本镜:景别/构图/动作/光影,并写明"角色与参考图1完全一致"」→ `shot.prompt`)
- **验收**:两张参考图同时生效(image-edit 的 in:images 多入);场景图缺省时链仍可跑。

### T03 镜头图生视频 `xingmang-drama-shot-video`

- **行业**:漫剧。**目标用户**:全体漫剧创作者。**卖点**:单镜头 3-8 秒行业规范直出 9:16;断线续查不丢任务;单镜成本透明。
- **节点**:`frame` / image-input;`motion` / prompt / `{ prompt: '' }`;`video` / video-generate / `{ durationSeconds: 8, model: 'grok-imagine-video', size: '720x1280' }`;`pick` / gallery;`output` / output
- **边**:`frame(out:image)→video(in:images)`;`motion(out:text)→video(in:text)`;`video(out:video)→pick(in:videos)`;`pick(out:video)→output(in:video)`
- **变量**:`frame`(asset, 必填 → `frame.assetId`);`motion`(text, 必填, 「表演与运镜:人物动作+镜头推拉摇移,一句话」→ `motion.prompt`)
- **备注**:可灵/即梦/Vidu 接入后本模板 version+1 换默认模型,是第 1 步「新模型必须伴随专属模板」的落点之一。

### T04 漫剧单集六镜骨架 `xingmang-drama-episode-6`

- **行业**:漫剧。**目标用户**:红果/抖音漫剧号与小工作室。**卖点**:打开即是半集的生产现场;逐镜「运行到节点」控费;是把客户月生成量放大一个数量级的载体。
- **结构**(25 节点/30 边):共享 `character` / image-input(x40,y60);支路 i(i=1..6,y=60+220×(i-1)):
  - `shot-i` / prompt / `{ prompt: '' }`(x360)
  - `edit-i` / image-edit / `{ count: 4, model: 'gpt-image-2', quality: 'low', size: '1024x1536' }`(x680)
  - `video-i` / video-generate / `{ durationSeconds: 6, model: 'grok-imagine-video', size: '720x1280' }`(x990)
  - 边:`character→edit-i(in:images)`;`shot-i→edit-i(in:text)`;`edit-i(out:image)→video-i(in:images)`;`shot-i(out:text)→video-i(in:text)`(运镜与画面同源描述,后期可拆两个 prompt)
- **变量**:`character`(asset, 必填);`shot-1..6`(text, 前两镜必填、其余选填, label「第 N 镜:画面+运镜」)
- **验收**:整链一次运行 24 图+6 视频;单跑 `video-3` 用「运行到节点」只触发该支路;video 产物直接批量另存进剪映。

### T05 六格不崩脸条漫 `xingmang-comic-strip-6`

- **行业**:漫画。**目标用户**:条漫/同人作者。**卖点**:多图参考一致性 SOP 开箱即用;重 roll 单格计费。
- **结构**(20 节点):`character` / image-input 共享;支路 i(1..6):`panel-i` / prompt、`edit-i` / image-edit `{ count: 4, model: 'gpt-image-2', quality: 'low', size: '1024x1536' }`、`pick-i` / gallery;末端 `output` / output 接 `pick-6`(成品逐格另存,拼接与嵌字按行业惯例出画布走 CSP/PS——模板 description 明示)。
- **边**:`character→edit-i(in:images)` ×6;`panel-i→edit-i(in:text)`;`edit-i→pick-i(in:images)`;`pick-6(out:image)→output(in:image)`
- **变量**:`character`(asset, 必填);`panel-1..6`(text, 第 1 格必填其余选填, label「第 N 格台本」)
- **升级钩子**:竖条拼接执行器落地后,6 个 gallery 汇入拼接节点直接出整条(蓝图第 2 步)。

### T06 线稿上色翻新 `xingmang-comic-lineart-color`

- **行业**:漫画(存量作者获客款)。**卖点**:对齐快看 AI 上色的存量场景。
- **节点**:`lineart` / image-input;`style` / prompt / `{ prompt: '为线稿上色:保持线条与构图完全不变,赛璐璐风格上色,干净高光' }`;`edit` / image-edit `{ count: 4, model: 'gpt-image-2', quality: 'low' }`;`pick` / gallery;`output` / output(边同 T09 形)
- **变量**:`lineart`(asset, 必填);`style`(text, 选填, 默认如上)

### T07 十二页绘本流水线 `xingmang-picturebook-12`

- **行业**:绘本。**目标用户**:宝妈副业/绘本工作室(80-150 元/单接单场景)。**卖点**:参考表架构保主角一致;改哪页跑哪页;.xingcanvas 即客户档案。
- **结构**(37 节点):`hero` / image-input(定妆图,来自 T01);页 i(1..12,两列布局:奇数页 y=60+220×⌊i/2⌋ 左列,偶数页右列错开):`text-i` / prompt、`page-i` / image-edit `{ count: 2, model: 'gpt-image-2', quality: 'low', size: '1024x1536' }`、`pick-i` / gallery
- **边**:`hero→page-i(in:images)` ×12;`text-i→page-i(in:text)`;`page-i→pick-i(in:images)`
- **变量**:`hero`(asset, 必填);`text-1..12`(text, 前 4 页必填其余选填, label「第 N 页文案(1-2 句,写明场景与动作)」)
- **备注**:count 用 2 不用 4——12 页 ×4 单轮 48 次消耗对接单毛利太重;description 写清「单本一轮约 24 次生成」。

### T08 课件插图四连 `xingmang-edu-courseware-4`

- **行业**:教育。**目标用户**:教师/教培机构。**卖点**:一次四张不同角度插图,横版直接进 PPT。
- **结构**:支路 i(1..4):`topic-i` / prompt(预填「示意图/卡通场景/流程配图/知识点拟人」四种风格前缀,变量替换主题词)、`gen-i` / image-generate `{ count: 2, model: 'gpt-image-2', quality: 'low', size: '1536x1152' }`;全部汇入 `pick` / gallery。
- **变量**:`topic-1..4`(text, 必填×1+选填×3, 默认值内嵌四种风格话术,label「知识点 N」)

### T09 白底图速产 `xingmang-ec-white-bg`

- **行业**:电商。**目标用户**:淘系/拼多多个体卖家。**卖点**:手机实拍 30 秒变审核可过白底图。
- **节点**:`photo` / image-input;`instruction` / prompt / `{ prompt: '将商品抠出置于纯白背景(#FFFFFF),商品居中占画面 80%,无阴影无道具,电商白底图规范' }`;`edit` / image-edit `{ count: 4, model: 'gpt-image-2', quality: 'low', size: '1024x1024' }`;`pick` / gallery;`output` / output
- **变量**:`photo`(asset, 必填);`instruction`(text, 选填, 默认如上)
- **合规注**:description 提示「生成式白底可能有边缘杂色,主图使用前请自查;面料/细节与实物不符会触发平台假图治理」。

### T10 场景图三连拍 `xingmang-ec-scene-3`

- **行业**:电商。**卖点**:一件商品一次铺三场景;换季只改提示词,指纹缓存不重复扣费。
- **结构**:`product` / image-input 共享;支路 i(1..3):`scene-i` / prompt(默认值:家居原木桌面/户外街拍/大促红金氛围)、`edit-i` / image-edit `{ count: 2, model: 'gpt-image-2', quality: 'low', size: '1024x1024' }`;汇入 `pick` / gallery → `output`。
- **变量**:`product`(asset, 必填);`scene-1..3`(text, 选填, 带默认场景话术)

### T11 主图规格三连 `xingmang-ec-size-trio`

- **行业**:电商(多平台铺货)。**卖点**:一次改词,1:1 / 3:4 / 16:9 三规格同步重出——批量矩阵节点上线前最能打的形态。
- **结构**:`product` / image-input + `sellpoint` / prompt 共享;三支路 `edit-sq` `{ size: '1024x1024' }` / `edit-vert` `{ size: '1152x1536' }` / `edit-wide` `{ size: '1280x720' }`(均 image-edit, count 2, gpt-image-2, low)各接自己的 gallery。
- **边**:`product→edit-*(in:images)` ×3;`sellpoint→edit-*(in:text)` ×3;`edit-*→pick-*(in:images)`
- **变量**:`product`(asset, 必填);`sellpoint`(text, 必填, 「商品名+核心卖点+场景要求,写明"保持主体一致,按画幅重新构图"」)

### T12 毛坯房秒变样板间 `xingmang-home-rough-6`(⭐ 首发主打,完整 TS 见附录)

- **行业**:家装。**目标用户**:家装公司/个体室内设计师。**卖点**:量房现场 1 分钟出 6 风格当场逼单(酷家乐已验证的场景);一轮 12 次扣费,是画布最强走量模板。
- **结构**:`room` / image-input 共享;支路 i(1..6):`style-i` / prompt(默认值:奶油风/原木风/意式极简/新中式/法式奶油/黑白灰现代,均带「保持房间结构、门窗位置、透视完全不变,仅做软硬装」前缀)、`edit-i` / image-edit `{ count: 2, model: 'gpt-image-2', quality: 'low', size: '1536x1152' }`;汇入 `pick` / gallery → `output`。
- **变量**:`room`(asset, 必填, 「毛坯房实拍(手机横拍即可)」);`style-1..6`(text, 全部选填带默认)
- **合规注**:description 写明「概念效果图,非施工图级交付」。

### T13 体块草模→方案效果图 `xingmang-arch-mass-render`

- **行业**:建筑。**目标用户**:中小事务所方案组/建筑学生。**卖点**:汇报前夜一晚 20 版,单张几元 vs 外包约 680 元/张。
- **节点**:`mass` / image-input(SU 截图);`brief` / prompt;`render` / image-edit `{ count: 4, model: 'gpt-image-2', quality: 'low', size: '1536x1152' }`;`pick` / gallery;`refine-brief` / prompt / `{ prompt: '在保持构图与体量不变的前提下,细化材质纹理与环境光影,提升写实度' }`;`refine` / image-edit `{ count: 2, ... }`;`output`
- **边**:`mass→render(in:images)`;`brief→render(in:text)`;`render→pick(in:images)`;`pick(out:image)→refine(in:images)`;`refine-brief→refine(in:text)`;`refine(out:image)→output`——注意 output 的 in:image 单入,refine 后直接出。
- **变量**:`mass`(asset, 必填);`brief`(text, 必填, 「材质/环境/时段,写明"严格保持建筑体量与视角"」)

### T14 旧改立面焕新对比 `xingmang-arch-renewal`

- **行业**:建筑/旧改(2025 年 2.71 万个小区开工的政策盘)。**卖点**:评审会「前后对比图」刚需,note 写改造说明,.xingcanvas 整包交付。
- **节点**:`site` / image-input;`plan` / prompt / `{ prompt: '' }`;`mode` 变量走 select 注入 plan 的默认话术;`edit` / image-edit `{ count: 4, model: 'gpt-image-2', quality: 'low', size: '1536x1152' }`;`pick` / gallery;`memo` / note / `{ text: '改造要点:\n1. \n2. ' }`;`output`
- **变量**:`site`(asset, 必填);`plan`(select, 必填, options: ['立面翻新:保留结构,更新涂料与门窗,增加外立面线脚','一层商业植入:保留上部住宅,首层改沿街商铺界面','适老化改造:加装电梯与无障碍坡道,更新公共空间'] → `plan.prompt`);`extra`(text, 选填, 追加要求 → 需第二个 prompt 节点 `extra` 与 edit 的 in:text 只能单入——**实现取舍**:将 select 与 text 合并为一个 text 变量+默认值下拉话术,或 plan 节点 prompt 用 select、extra 并入 note。首选前者:一个 text 变量,defaultValue 为立面翻新话术,label 里列出三种可替换话术。)
- **验收**:原图与生成图在画布上同屏对比;导出项目包后在另一台机器可完整打开。

### T15 小红书封面四连拍 `xingmang-media-xhs-cover`

- **行业**:自媒体。**目标用户**:图文博主/副业新手。**卖点**:3:4 流量位一次挑 4 张;按次扣费不买月卡。
- **节点**:`topic` / prompt;`gen` / image-generate `{ count: 4, model: 'gpt-image-2', quality: 'low', size: '1152x1536' }`;`pick` / gallery;`output`
- **变量**:`topic`(text, 必填, 「话题+风格+主色调,如"秋季通勤穿搭 胶片感 米棕色系";大字标题建议导出后用稿定/醒图叠加」)
- **注**:文字上屏是行业 P0 缺口,本模板刻意只做「底图」并在 label 里说清——不承诺文字排版。

### T16 口播 B-roll 素材包 `xingmang-media-broll-3`

- **行业**:自媒体。**目标用户**:知识/测评类口播博主。**卖点**:告别翻素材库半小时,一次出整条片的三段空镜。
- **结构**:支路 i(1..3):`beat-i` / prompt → `frame-i` / image-generate `{ count: 1, model: 'gpt-image-2', quality: 'low', size: '720x1280' }` → `clip-i` / video-generate `{ durationSeconds: 6, model: 'grok-imagine-video', size: '720x1280' }` → `out-i` / output
- **边**:`beat-i→frame-i(in:text)`;`frame-i(out:image)→clip-i(in:images)`;`beat-i(out:text)→clip-i(in:text)`
- **变量**:`beat-1..3`(text, 第 1 段必填, label「分镜要点 N:画面内容+镜头运动」)

### T17 道具图标套系 `xingmang-game-icon-set`

- **行业**:游戏。**目标用户**:手游/小游戏 UI 与外包工作室。**卖点**:上百个图标一个风格;是消耗 quota 的量产大户。
- **节点**:`anchor` / image-input(已定稿 icon 作风格锚);`item` / prompt;`edit` / image-edit `{ count: 4, model: 'gpt-image-2', quality: 'low', size: '1024x1024' }`;`pick` / gallery;`output`
- **变量**:`anchor`(asset, 必填, 「风格锚:一张已定稿的图标」);`item`(text, 必填, 「新道具:名称/材质/稀有度,写明"与参考图标同风格同透视"」)
- **升级钩子**:background:transparent 参数透传落地后加「透明底」开关(蓝图缺口矩阵第 3 行,参数级)。

### T18 角色立绘差分工厂 `xingmang-game-variant`

- **行业**:游戏(二游/视觉小说)。**卖点**:一张定稿扩全套表情差分,4 候选挑最稳。
- **节点**:`base` / image-input;`variant` / prompt / `{ prompt: '保持角色长相、发型、服装、姿势完全一致,仅修改表情为:' }`;`edit` / image-edit `{ count: 4, model: 'gpt-image-2', quality: 'low', size: '1024x1536' }`;`pick` / gallery;`output`
- **变量**:`base`(asset, 必填);`variant`(text, 必填, 「差分要求:表情/服装/姿势改哪个,改成什么」→ 覆盖 `variant.prompt`,默认话术保留在 defaultValue)

### T19 信息流 AB 素材产线 `xingmang-ad-ab-pair`

- **行业**:广告投放。**目标用户**:千川/信息流投手。**卖点**:应对素材衰减的周更压力,一次出图+视频成对 AB 素材。
- **结构**:支路 A/B:`sell-A` / prompt → `img-A` / image-generate `{ count: 2, model: 'gpt-image-2', quality: 'low', size: '720x1280' }` → `vid-A` / video-generate `{ durationSeconds: 5, model: 'grok-imagine-video', size: '720x1280' }` → `out-A` / output(B 同构)
- **变量**:`sell-A`(text, 必填, 「卖点 A 的画面脚本」);`sell-B`(text, 必填)

### T20 分镜帧转动态预演 `xingmang-film-animatic`

- **行业**:影视/广告导演。**卖点**:给甲方看「会动的分镜」赢比稿——最直接的充值理由。
- **节点**:`frame` / image-input(手绘或 AI 分镜静帧);`camera` / prompt / `{ prompt: '固定机位,轻微推近' }`;`video` / video-generate `{ durationSeconds: 5, model: 'grok-imagine-video', size: '1280x720' }`;`pick` / gallery;`output`
- **变量**:`frame`(asset, 必填);`camera`(text, 必填, 「运镜:推/拉/摇/移/跟/固定 + 节奏,一句话」, defaultValue '固定机位,轻微推近')
- **配套**:随本模板发一包「镜头语言」提示词预设(景别×运镜×灯光×胶片风格,进提示词预设库,零开发)。

---

## 3. 上线节奏与度量

1. **首发 4 套**(四个第一梯队行业各一,先验证 config 透传风险点):T12 毛坯房、T09 白底图、T15 小红书封面、T01 角色设定卡。跑通后批量铺其余 16 套。
2. **店面**:模板选择器按行业分栏(漫剧/电商/家装建筑/自媒体/游戏/更多),每套显示「跑一次约 N 次生成」标签(先静态写进 description,店面 UI 化排第 2 步)。
3. **度量**:以模板落位次数与落位后 7 日生成量为北极星;提示词预设包使用量作行业探针——哪个行业的包用得多,优先给哪个行业补第二批模板与模型。
4. **每周随更新推 1-2 套新模板**,每套配一张前后对比图作内容营销素材(OpenArt/Higgsfield 的增长本质是「模板即获客内容」)。

---

## 附录:完整 TS 示例(T12 毛坯房秒变样板间)

> 展示多支路共享输入 + 默认话术变量的写法;其余模板照此机械转写。坐标按第 0 节网格。

```ts
const roughRoomSix: CanvasTemplate = {
  id: 'xingmang-home-rough-6',
  version: 1,
  name: '毛坯房秒变样板间',
  description: '一张毛坯实拍并行生成六种装修风格效果图。跑一次约 12 次图像生成;概念效果图,非施工图级交付。',
  category: 'image',
  tags: ['家装', '效果图', '多风格'],
  thumbnail: { kind: 'color', value: '#7A5C3D' },
  requiredNodeTypes: ['image-input', 'prompt', 'image-edit', 'gallery', 'output'],
  workflow: {
    nodes: [
      { id: 'room', type: 'image-input', definitionVersion: 1, position: { x: 40, y: 560 }, config: {} },
      ...[
        '奶油风:保持房间结构、门窗位置与透视完全不变,奶油白墙面、微水泥地面、圆弧家具、暖光',
        '原木风:保持房间结构、门窗位置与透视完全不变,浅色木饰面、亚麻布艺、绿植点缀、日光',
        '意式极简:保持房间结构、门窗位置与透视完全不变,无主灯设计、大平层质感、深色石材点缀',
        '新中式:保持房间结构、门窗位置与透视完全不变,胡桃木家具、宣纸灯、留白构图',
        '法式奶油:保持房间结构、门窗位置与透视完全不变,石膏线、金属把手、法式拱形元素',
        '黑白灰现代:保持房间结构、门窗位置与透视完全不变,高级灰墙面、黑色金属细框、极简软装',
      ].flatMap((prompt, i) => [
        { id: `style-${i + 1}`, type: 'prompt', definitionVersion: 1, position: { x: 360, y: 60 + 220 * i }, config: { prompt } },
        { id: `edit-${i + 1}`, type: 'image-edit', definitionVersion: 1, position: { x: 680, y: 60 + 220 * i }, config: { count: 2, model: 'gpt-image-2', quality: 'low', size: '1536x1152' } },
      ]),
      { id: 'pick', type: 'gallery', definitionVersion: 1, position: { x: 990, y: 560 }, config: {} },
      { id: 'output', type: 'output', definitionVersion: 1, position: { x: 1300, y: 560 }, config: {} },
    ],
    edges: [
      ...Array.from({ length: 6 }, (_, i) => [
        { id: `room-edit-${i + 1}`, source: 'room', sourceHandle: 'out:image', target: `edit-${i + 1}`, targetHandle: 'in:images' },
        { id: `style-edit-${i + 1}`, source: `style-${i + 1}`, sourceHandle: 'out:text', target: `edit-${i + 1}`, targetHandle: 'in:text' },
        { id: `edit-pick-${i + 1}`, source: `edit-${i + 1}`, sourceHandle: 'out:image', target: 'pick', targetHandle: 'in:images' },
      ]).flat(),
      { id: 'pick-output', source: 'pick', sourceHandle: 'out:image', target: 'output', targetHandle: 'in:image' },
    ],
  },
  variables: [
    { id: 'room', label: '毛坯房实拍(手机横拍即可)', type: 'asset', required: true, target: { nodeId: 'room', path: 'assetId' } },
    ...Array.from({ length: 6 }, (_, i) => ({
      id: `style-${i + 1}`,
      label: `风格 ${i + 1}(可改写,留空用默认)`,
      type: 'text' as const,
      required: false,
      target: { nodeId: `style-${i + 1}`, path: 'prompt' },
    })),
  ],
  provenance: { kind: 'xingmang-original' },
}
```

> ⚠️ 转写提醒:`builtin-templates.ts` 现有三套全部是纯字面量写法。如果团队希望保持「模板文件零逻辑、肉眼可 diff」,把上面 flatMap/Array.from 展开成 6 组字面量即可(多 60 行,换全字面量可审计性)——这与 CLAUDE.md「主进程信任链不上 bundler、preload 有意重复」的可审计取向一致,推荐展开。

# 无限画布前端重写方案

> 立项:2026-08-19。老板拍板「推倒重写画布前端,只保留主进程和数据契约」,从界面与布局先出效果。
>
> **本文是执行计划 + 进度记录。每完成一小项回写第 7 节进度表。**
> 与代码冲突时以代码为准;完成一批后同步回写 `docs/INFINITE-CANVAS-HANDOFF.md`。
>
> 基线提交:`481d070`(在 `95c351f` 固化在飞改动、移除简单模式之后)。
> 回滚锚点:`git reset --hard 481d070`。

---

## 1. 为什么要重写

四路独立调研 + 一路代码审计收敛出三条根因,都不是「多加几个功能」能解决的:

**观感差 = 没有令牌纪律。** `styles.css` 有约 91 处硬编码颜色绕过令牌;约 100 条不同的 `font-size`,从 8px 到 22px,没有任何比例尺;padding/margin 用了 20 多个互不相干的 px 值。行业模板库那一块(`styles.css:2054` 起)甚至自带一套 `#111722` + 20px 圆角的独立微设计,而 `INFINITE-CANVAS-HANDOFF` §2.1 明写「圆角不超过 8px」「亮暗主题必须共用语义令牌」。

**难用 = 边和参数两处失守。** 边是节点编辑器里第二高频操作的对象,当前注册了**零个** `edgeTypes`(`App.tsx:2619-2664` 核实):没有悬停态、没有按类型着色、没有工具条、不能改接、命中区域只有细线宽。参数则同时活在节点体(`WorkflowNodes.tsx:584-705`)和检查器(`CanvasInspector.tsx:72-121`),两套独立控件、两个真相源。

**结构性堵点。** `App.tsx:2637` 用 `onInit` 把实例存进 ref,而不是 `ReactFlowProvider`。这导致**任何子组件都无法使用 React Flow 的 hook**——`useConnection`、`useNodesData`、`useUpdateNodeInternals`、`experimental_useOnNodesChangeMiddleware` 全部不可达,堵死了连线引导、吸附辅助线、节点自测量等一整片改进。

另有资产库的**真缺陷**(非体验问题):`electron/ai-media-asset-service.ts:73-75` 先 `listOwned(userId, 500)` 截断,再在 84-109 行做筛选/搜索/排序/分页,并在第 109 行返回一个自信的 `total`。超过 500 个资产后,搜索与排序**静默返回错误结果**。

---

## 2. 重写边界

| 处置 | 范围 | 行数 |
|---|---|---|
| **推倒重写** | `App.tsx`、`components/`(23 个)、`nodes/`、`styles.css`、`theme/` | ~7900 |
| **原样保留** | `persistence/`、`runtime/`、`store/`、`domain/`、`ports.ts`、`models.ts`、`model.ts`、`host.ts` | ~5200 |
| **保留并按新交互扩充** | `editor/`、`engine/`、`templates/`、`library/` | ~1700 |
| **完全不动** | `electron/` 全部主进程(批次 4 的缩略图管线除外) | — |

**为什么领域逻辑层不重写。** 它不是「前端」,是被 41 个测试文件钉死的纯函数,其中数条直接管付费安全:`runtime/run-preflight.ts` 在付费 IPC 之前阻断不兼容的模型/分组/尺寸组合;`persistence/workflow-sanitizer.ts` 剥离 apiKey/token/cookie/绝对路径/远程 URL(I15 的兑现方式之一,有自动门禁盯着);`runtime/candidates.ts` 的「新候选不自动覆盖已采纳结果、丢弃不删素材」是产品决策。重写它们等于把已通过对抗审查的结论重新论证一遍,风险全在下行方向。

**唯一的越界**:批次 2 的 pinned 参数要在持久化 schema 增加一个可选字段。按 CLAUDE.md 约定做成 `field?:`、缺省等于旧行为,不改迁移链。

---

## 3. 许可证台账(逐个核实 LICENSE 原文,不信 GitHub 侧边栏)

### 可采用(逐文件审计 + 锁 commit + 登记 `docs/canvas-third-party.json` 后)

| 项目 | 许可证 | 对我们的价值 |
|---|---|---|
| xyflow/xyflow 及其**免费**示例 | MIT | 一方 API 与免费示例源码 |
| invoke-ai/InvokeAI | Apache-2.0 | staging/候选对比/gallery,语义与我们几乎同构 |
| langflow-ai/langflow | MIT | `DESIGN.md` 令牌规范、参数可见性管理模型 |
| kestra-io/kestra | Apache-2.0 | 排队时长与运行时长分离、状态优先级上卷 |
| rgthree/rgthree-comfy | MIT | 双层进度条、reroute |
| mcmonkeyprojects/SwarmUI | MIT | 参数分组元数据模型 |
| dagrejs/dagre | MIT | 自动布局(若需替换现有实现) |
| excalidraw、Drawflow、baklavajs、X6、react-diagrams | MIT | 交互参考 |

### 仅可研究行为(禁止复制源码/CSS/文案/图标/布局/独特视觉表达)

ComfyUI 与 ComfyUI_frontend(**GPL-3.0**,含内嵌 litegraph)、ComfyUI-Manager、Easy-Use(GPL)、Immich(AGPL)、PhotoPrism(**AGPL**,GitHub API 却报 `NOASSERTION`)、Krita AI Diffusion(GPL)、Fooocus(GPL)、A1111 与 Forge(AGPL)、Blender(GPL)、Natron(GPL-2.0)、n8n(**Sustainable Use License**,限内部/非商业)、tldraw(**明文禁止生产环境使用**)、Windmill(AGPL + 禁商业嵌入)、Dify(Apache + 商业条款 + **外观专利主张**)、Houdini/Nuke/Unreal/Substance(专有)。

### 三个必须记住的陷阱

1. **litegraph 陷阱**:单独仓库 `jagenjo/litegraph.js` 是 MIT,但活跃版本内嵌在 `ComfyUI_frontend/src/lib/litegraph`,随该仓库以 GPL-3.0 分发。**你自然会打开的那份正是不能用的那份。**
2. **Rete 陷阱**:核心与多数插件是 MIT,但 `rete-scopes-plugin`(实现嵌套/父子节点,恰是做子图时最想抄的)是 **CC-BY-NC-SA-4.0**,非商业,硬阻断。
3. **elkjs 不是宽松许可**:EPL-2.0 弱著佐权。作为未修改的 npm 依赖使用属常规做法,但复制其源码进我们文件会触发披露义务。要自动布局用 MIT 的 dagre。

### 其他判定

- **React Flow Pro 不锁任何功能**,只卖示例源码、优先支持与去水印权($169–289/月)。无需购买。
- `proOptions={{ hideAttribution: false }}` 保持不变。去水印需订阅,对付费产品是无谓的许可风险。
- Langflow 的 `DESIGN.md` 虽是 MIT,**我们仍不采用其内容**,只作参考。理由:他们是亮色优先的单色系 + 14 种数据类型色,与我们暗色优先 + 5 种端口类型不匹配;而真正有价值的数字(4px 栅格、≤8px 圆角、11px 字号下限)本就是功能性事实,且与 §2.1 已有原则一致。记为研究来源,不登记 adapted 文件。

---

## 4. 设计令牌规范

**策略:增量补齐,不重命名。** 现有 `theme.css` 的 35 个令牌命名合理且已被两套主题覆盖,全量重命名只会摧毁 git blame。做法是补齐缺失的比例尺,再把 91 处硬编码迁移过来。

### 4.1 保留(已存在,不动)

表面 `--canvas-bg` `--surface-1/2/3` `--surface-hover/input/media/floating/floating-strong/rail`;边框 `--border-subtle/strong`;文本 `--text-primary/secondary/muted`;强调 `--accent` `--accent-hover` `--accent-soft`;状态 `--success` `--warning` `--danger` `--focus`;端口 `--port-text/image/video/audio`;`--shadow-floating`;`--radius-control`(6px) `--radius-panel`(8px);全部 `--xy-*` 覆盖。

### 4.2 新增

```
/* 间距 — 2px 基底,13 档,按值命名(--space-10 就是 10px,无索引歧义) */
--space-2: 2px;    --space-4: 4px;    --space-6: 6px;    --space-8: 8px;
--space-10: 10px;  --space-12: 12px;  --space-16: 16px;  --space-20: 20px;
--space-24: 24px;  --space-32: 32px;  --space-40: 40px;  --space-48: 48px;
--space-56: 56px;

/* 字阶 — 11px 是硬下限,低于此改用简化表达而非缩小字号 */
--text-xs: 11px;    /* 徽章、元信息、耗时 */
--text-sm: 12px;    /* 参数标签与取值 */
--text-base: 13px;  /* 节点标题、正文 */
--text-md: 14px;    /* 面板标题 */
--text-lg: 16px;    /* 区域标题 */
--text-xl: 20px;    /* 页面级标题 */

/* 字重 */
--weight-normal: 400;  --weight-medium: 500;
--weight-semibold: 600;  --weight-strong: 650;

/* 圆角 — 补一档小的与一档全圆,上限仍是 8px(§2.1) */
--radius-chip: 4px;  --radius-round: 999px;

/* 层级 */
--z-canvas-overlay: 10;  --z-panel: 20;  --z-floating: 30;
--z-modal: 40;           --z-toast: 50;

/* 动效 */
--duration-fast: 120ms;  --duration-base: 180ms;
--ease-out: cubic-bezier(0.2, 0, 0, 1);

/* 运行状态语义层 — 与 success/warning/danger 解耦,便于单独调 */
--state-dirty: var(--warning);
--state-queued: #6c8cd5;   /* 亮色主题 #4a6ab0 */
--state-running: var(--accent);
--state-cached: #6b7683;   /* 亮色主题 #7c8794 */
--state-succeeded: var(--success);
--state-failed: var(--danger);

/* 端口补齐第五种 */
--port-any: #8b95a3;       /* 亮色主题 #6b7683 */

/* 节点几何 — 批次 2 使用 */
--node-width: 280px;
--node-width-min: 240px;
--node-header-height: 36px;
--node-row-height: 28px;
--node-spine-width: 3px;
--node-label-column: 92px;
--node-control-min: 128px;
```

**刻意偏离调研建议之处**:调研给出节点外圆角 10px,我们用 8px,因为 §2.1 的「圆角不超过 8px」是本仓已定原则,原则优先于外部参考。

### 4.3 令牌纪律

- 业务组件里**不出现字面颜色值**。唯一允许写死颜色的文件是 `theme.css`。
- 字号只能取字阶六档之一。**任何低于 11px 的渲染一律视为缺陷**,该用简化表达。
- 间距只能取 `--space-*`。两个例外由门禁显式豁免:`calc/clamp/min/max` 里的视口相关公式(改一项就是改公式而不是改节奏),以及负值偏移(那是刻意的重叠,不是节奏)。
- **为什么不是 4px 栅格**:研究给的是 Langflow 的 4px 基底,但本仓控件长在偶数像素节奏上,10px×71、6px×51、7px×49 是最密集的档位。强推 4px 会让 300 多处声明位移最多 33%,换不来任何视觉收益。2px 基底把 26 种取值收敛到 13 种且全部偶数,同样建立了纪律,而最大位移只有 4px。
- 状态表达**不得只依赖颜色**(§2.1),必须同时有文字或形状。

---

## 5. 批次分解

每一项都是独立可验收、可单独回滚的最小单元。编号用于第 7 节进度表。

### 批次 1 · 地基与外壳(界面与布局)

| 编号 | 内容 |
|---|---|
| B1-1 | `theme.css` 补齐 §4.2 全部新增令牌,暗/亮双主题各一份 |
| B1-2 | `ReactFlowProvider` 接管:`App.tsx` 拆掉 `onInit` + `reactFlowRef`,改用 `useReactFlow`,解锁子组件 hook |
| B1-3 | `styles.css` 硬编码迁移第一轮:颜色 91 处 → 令牌 |
| B1-4 | `styles.css` 字号统一到六档字阶;消灭所有 <11px |
| B1-5 | `styles.css` 间距统一到 `--space-*`。**执行顺序已调整到批次 1 最后**:间距是被布局决定的,而 B1-7 工具栏重组、B1-12 响应式抽屉与批次 2 节点解剖会大面积重写这些声明,先对齐等于做两遍。字号则相反(驱动布局),故 B1-4 必须先做 |
| B1-6 | 行业模板库微设计并入主令牌(`styles.css:2054` 起,含 20px 圆角违规) |
| B1-7 | 工具栏重组:文件菜单 / 编辑组 / **运行分裂按钮**(吞掉 4 种运行范围) / 视图与面板切换,15 项收成 11 项 |
| B1-8 | 消除导航控件重复:顶栏中间与右下角当前都有适配/聚焦,保留一处 |
| B1-9 | 自绘 `Controls`(替换 React Flow 默认外观)+ `ControlButton` 承载自定义项 |
| B1-10 | MiniMap 自绘:按运行状态着色(`nodeColor`),<1200px 默认关闭 |
| B1-11 | 双层 `Background`(major/minor 栅格),让吸附有视觉依据 |
| B1-12 | 响应式:<1200px 创作库转 48px 图标轨、检查器转覆盖式抽屉、画布最小 480px |
| B1-13 | 面板状态存比例不存像素,按布局模式分键;恢复时校验并自愈越界值 |
| B1-14 | `ariaLabelConfig` 中文化(React Flow 内置英文无障碍文案对中文产品是可见缺陷) |
| B1-15 | 清理遗留死 CSS:独立 `.asset-tray` / `.run-inspector.is-open` 浮层规则与嵌入式检查器并存 |
| B1-16 | 令牌纪律自动门禁:`canvas-v2/src/theme/token-discipline.test.ts` 扫描 `styles.css`,断言零字面色、字号只取六档、圆角不超 8px、每个 `var(--x)` 都能解析 |

### 批次 2 · 节点解剖

| 编号 | 内容 |
|---|---|
| B2-1 | 状态脊:节点左缘 3px 全高色条,按运行状态着色,低缩放下仍可读 |
| B2-2 | 三列子栅格参数行:`12px 槽 / 92px 标签 / 1fr 控件(min 128px) / 12px 右边距` |
| B2-3 | 由最长选项文本反推节点最小宽度,根除下拉截断 |
| B2-4 | 标识中段截断、散文末段截断;短显示名 + 完整 ID 进 tooltip |
| B2-5 | 参数单一真相源:节点体只放 pinned 项,检查器改为可见性管理器 |
| B2-6 | pinned 持久化:`WorkflowNodeData` 增加可选 `pinnedParams?: string[]`,schema v2 向后兼容 |
| B2-7 | 端口语义:色相=类型(补 `--port-any`)、形状=基数、填充=已连接 |
| B2-8 | 可提升参数的端口点悬停才显露,静息时节点保持干净 |
| B2-9 | 进度发丝线:2px,压在 header 下边缘复用边框,运行时零高度变化 |
| B2-10 | 校验错误(琥珀,阻断运行)与执行错误(红,可重试)分离表达 |
| B2-11 | 缓存命中的独立视觉:slate 状态脊 + 「已缓存」标签 + 无动画 |
| B2-12 | 真 LOD:低缩放切换为图标 + 标题的简化表达,阈值 `minPx / (baseFont × √DPR)` |
| B2-13 | `NodeResizer` / `NodeResizeControl` 用于媒体与预览节点,图片保持宽高比 |
| B2-14 | 节点标题单行截断 + tooltip,永不换行(换行会导致节点重排,破坏空间记忆) |

### 批次 3 · 交互层

| 编号 | 内容 |
|---|---|
| B3-1 | 注册自定义 `edgeTypes`:宽命中路径、悬停态、按端口类型着色 |
| B3-2 | `EdgeToolbar`(v12.9+)承载删除边、在此插入节点 |
| B3-3 | `reconnectEdge`:拖动边端点改接到其他端口 |
| B3-4 | `onNodeContextMenu` + `onSelectionContextMenu`,补齐画布/节点/边/选区四套右键菜单 |
| B3-5 | `zoomOnDoubleClick={false}`,双击语义归位:空白=快速创建、标题=重命名、节点体=展开 |
| B3-6 | `useConnection` 连线引导:拖线时不兼容端口变暗、兼容端口放大 |
| B3-7 | `elevateNodesOnSelect` + `zIndexMode`,选中节点不再被邻居盖住 |
| B3-8 | `nodeDragThreshold` + `noDragClassName` / `noWheelClassName` / `noPanClassName`,修复节点内滑块与滚动 |
| B3-9 | 撤销粒度:一手势一步(拖拽/缩放开始建事务、结束提交;文本改动 blur 时提交) |
| B3-10 | 对齐与分发命令(左/右/上/下/水平居中/垂直居中/等距) |
| B3-11 | 辅助线吸附:`experimental_useOnNodesChangeMiddleware` 拦截位移,`ViewportPortal` 画参考线 |
| B3-12 | 切线手势:按修饰键划过连线批量断开 |
| B3-13 | reroute 节点:1 进 1 出直通,用于折弯长连线 |
| B3-14 | 删除并重连:删除中间节点时自动把上游接到下游 |
| B3-15 | 拖节点到连线上插入(当前只能走边右键菜单) |
| B3-16 | 跳过(bypass)语义:输入透传到匹配输出,下游继续工作;不做 mute/bypass 双态 |
| B3-17 | 框选修饰键:直接拖=替换、Shift=追加、Ctrl=移除 |
| B3-18 | 搜索并跳转节点;`.` 聚焦选中、`Home` 适配全部 |

### 批次 4 · 资产库

| 编号 | 内容 |
|---|---|
| B4-1 | **修正截断搜索**:筛选/搜索/排序下推到存储层,或先建索引再筛选;`total` 必须是真实总数 |
| B4-2 | 主进程缩略图管线:320px 派生图,`createImageBitmap` + `OffscreenCanvas` 跑在 `utilityProcess`,零新依赖 |
| B4-3 | 缩略图经独立协议主机 `xingmang-asset://thumb/<assetId>` 提供,内容寻址可永久缓存,路径含版本段便于整体失效 |
| B4-4 | 视频封面帧:优先 `nativeImage.createThumbnailFromPath`(仅 Windows/macOS,正是我们两个平台),回退到 `<video>` seek 到 `min(1.0, duration*0.1)` 再 drawImage |
| B4-5 | 停止每个瓦片挂 `<video>`;悬停擦除用预生成雪碧图,全网格最多一个活动媒体元素 |
| B4-6 | 分面/标签计数走全集(当前 `AssetTray.tsx:96` 从 `page.items` 派生,翻页即变) |
| B4-7 | 选中模型显式化:删掉 `onMouseLeave` 清选中 + `focused.blur()`(后者会抢走键盘焦点,是无障碍缺陷) |
| B4-8 | 多选:Ctrl 切换、Shift 范围、Ctrl+A 全选、右键保留既有选区 |
| B4-9 | 详情面板移出卡片(当前内联展开会重排网格,把瓦片从光标下挪走) |
| B4-10 | 键盘导航:roving tabindex、方向键、`.` 收藏、`/` 搜索、查看器 `←/→` |
| B4-11 | 骨架瓦片 + 查询切换时保持网格高度,消除跳动 |
| B4-12 | 五种空状态分别给出正确的下一步动作 |
| B4-13 | 密度三档(72/96/132px)并持久化 |
| B4-14 | 筛选面重构:工具行 + 弹出式编辑器 + 可移除筛选标签,回收约 90px 竖向空间 |
| B4-15 | 软删除 + 回收站 + 撤销 toast;永久删除走 `shell.trashItem` 并在此处才做引用阻断 |
| B4-16 | 提示词优先的元信息 + 复制 + 「找相似」(同提示词/同运行/同来源节点) |

---

## 6. 每批验收门槛

每一批合并前必须全过,数字记入进度表:

```powershell
npm run canvas:prepare      # 含画布 tsc
npm run typecheck           # 三段
npm run test:canvas
npm test                    # 失败集合必须与基线逐条一致
npm run test:canvas:visual  # 四视口 + 125%/150%
node --test scripts/verify-canvas-provenance.test.cjs scripts/verify-canvas-renderer-boundary.test.cjs
git diff --check
```

**基线失败集合(Windows 本机,环境相关,非回归)**:

- **以 `npm run test:windows` 为准:4 项**,全部是符号链接 `EPERM`(需开启 Windows
  开发者模式)。这是真正的代码级基线。
- `npm test` / 裸 `vitest` 会额外报 5~6 项 5 秒超时,那是文件级并行 + Defender
  实时扫描的抖动,**不是回归**。同一批改动下这个数字会在 9~10 之间浮动,
  因此判断有无新增失败必须用 `test:windows`。
- ⚠️ `npm test` 是 `vitest && test:node`,vitest 一旦非零退出就**短路**,
  `test:node` 不会执行。本机需单独跑 `npm run test:node`(85 项脚本 + 18 项
  浏览器用例,需先 `npx playwright install chromium`)。

任何超出上述 4 项的失败都按回归处理。

额外要求:

- 视觉 smoke 的 `clippedControls`、`brightNodeShells`、`overlap`、`externalRequests`、`consoleErrors`、`pageErrors` 全为 0。
- 令牌纪律:业务 CSS 中字面颜色数归零(`theme.css` 除外)。
- 不推送、不开 PR,除非老板明确发话。

---

## 7. 进度

图例:`○` 未开始 · `◐` 进行中 · `●` 已完成 · `⊘` 核实后取消

> 记录约定:提交号在**下一项落地时**回填(一次提交无法包含自己的哈希)。
> 回写本表**只能用编辑器**——PowerShell 5.1 的 `Set-Content` 会按系统代码页
> 读写,把本文的中文整体损坏(2026-08-19 已发生一次,从 `c4c5e24` 恢复)。

### 批次 1 · 地基与外壳

| 项 | 状态 | 提交 | 备注 |
|---|---|---|---|
| B1-1 令牌补齐 | ● | `f62c6be` | 新增间距 8 档、字阶 6 档、字重 4 档、层级 5 档、动效 3 项、运行状态 6 色、`--port-any`、节点几何 7 项;亮色主题补 3 个独立色值 |
| B1-2 ReactFlowProvider 接管 | ● | `f62c6be` | `main.tsx` 包 Provider;`App.tsx` 18 处 `reactFlowRef.current` → `useReactFlow()`,删 `onInit`。**语义修正**:`getNodes()` 在 hook 下返回 `[]` 而非 `undefined`,alt-drag 的 `?? fallback` 改为长度判断 |
| B1-3 颜色迁移 | ● | `2d0c342` | 91 → 44。新增 19 个语义令牌:`--text-on-accent`、`--divider-on-accent`、媒体覆盖层 4 项、`--overlay-hover`、`--favorite`、`--waveform`、背景遮罩 3 档、阴影 5 档。**剩余 44 处全部落在行业模板库 1900-1952 行**,归 B1-6。四视口平均亮度与基线逐位相同(28.6/26.0/25.0/21.2),迁移视觉忠实 |
| B1-4 字阶统一 | ● | `76a0aac` | 167 处声明归入六档。**基线里 168 处有 107 处低于 11px**(8px 7 处、9px 45 处、10px 55 处),即 64% 的画布文字此前渲染在 8-10px——这是「观感差」的首要原因。提到 11px 后四视口 `clipped=0`,布局宽度未变 |
| B1-6 模板库微设计并入 | ● | (见下) | **字面色 44 → 0,超标圆角 7 种 → 0**,另顺手令牌化 42 处合规圆角。修掉两个真 bug:`color: var(--text, #eef2f8)` 引用的 `--text` **从未定义过**;整块硬编码深色面导致亮色主题下弹窗仍是深色板。琥珀主操作色统一到 `--accent` |
| B1-16 令牌纪律门禁 | ● | (见下) | 新增 7 项断言。`theme.css`+`styles.css` 共 103 个令牌,`styles.css` 引用 56 个,唯一未定义的 `--wf-progress` 是 JS 注入且带 fallback,已列入白名单并断言其必须保留 fallback |
| B1-5 间距统一 | ● | (见下) | **26 种取值 → 13 档**,511 处令牌化。改用 2px 基底而非研究建议的 4px 栅格(理由见 §4.3)。位移全部 ≤2px,唯一例外是 3 处 `28→24`;331 处值根本没变、只是令牌化。`calc/clamp` 表达式 2 条与负偏移 1 处按门禁豁免保留。四视口布局尺寸与亮度与改动前逐位相同 |
| B1-7 工具栏重组 | ● | `80df65c` | **计划被过时截图误导,已重新定界**:运行分裂按钮早已存在且完全符合研究建议(主面执行当前范围、`▾` 选范围、运行中变取消),工具栏也已是 11 个控件=推荐值。实际改动:运行历史升级为带 `aria-pressed` 的面板开关;「聚焦模式」换 `PanelRight` 图标并改名「隐藏侧边面板」——原先它与右下角「聚焦选中节点」**共用 `Focus` 图标却是两个完全不同的动作** |
| B1-8 导航控件去重 | ● | `80df65c` | `适配全部内容` 原本在顶栏与右下角各一份。保留顶栏那个(研究的 Zone 4 本就把「适应」放工具栏,且 smoke 有 7 处调用依赖它),删掉右下角的;右下角只留「聚焦选中节点」与小地图 |
| B1-9 自绘 Controls | ⊘ | | **核实后取消**:`theme.css` 的 `--xy-controls-button-*` 覆盖早已给原生 Controls 上色,B1-14 又补齐中文无障碍文案,四视口 smoke 也未报裁切。自绘一遍只是换实现不换观感,无收益 |
| B1-10 MiniMap 状态着色 | ● | `c23d480` | `nodes/minimap-node-color.ts` 纯函数 + 4 项测试。**按优先级而非查表**:失败 > 运行中 > 排队 > 待更新 > 成功 > 空闲,确保失败永不被陈旧的成功状态掩盖 |
| B1-11 双层 Background | ● | `c23d480` | 16px 点阵次栅格 + 96px 线条主栅格,让对齐与吸附有视觉依据。四视口亮度升 2-3 点(远低于 90 阈值),`veryLightRatio` 不变 |
| B1-12 响应式覆盖式抽屉 | ● | `43041a9` | 覆盖式抽屉本已存在(≤1180px 时 `.canvas-inspector` 即绝对定位浮层)。**真缺口是可用画布宽度**:960px 下创作库 268 + 画布容器 692,而 292px 检查器浮在其上,实际可见画布仅 **400px**,低于 480px 底线。用 `:has()` 让窄屏开面板时创作库退回 48px 图标轨,可见画布 **400 → 620px**。纯 CSS,不改写持久化的 `libraryCollapsed` 偏好 |
| B1-13 面板状态存比例 | ● | `9b36e12` | **前提不成立,已改做真缺陷**:偏好里根本没有像素宽度(只有 3 个布尔 + 1 个枚举),面板宽度全是 CSS `clamp()`,且研究明确反对可自由拖拽的抽屉。真缺陷是 `version` 字段只写不校验——**装饰性版本号**。现改为读取时未知版本整体回退默认值。原测试第 31 行恰好把该缺陷钉死(断言 `version: 99` 的载荷字段仍被接受),已拆成「当前版本逐字段净化」与「未知版本整体拒绝」两例 |
| B1-14 ariaLabelConfig 中文化 | ● | `c23d480` | `aria-labels.ts` 覆盖全部 12 条内置英文文案(节点/连线的键盘说明、实时播报、控件、缩略图、端口)。smoke 端到端断言「放大」存在且 "Zoom In" 不存在,防止键名写错时静默回退 |
| B1-15 死 CSS 清理 | ● | (见下) | `styles.css` **2111 → 1933 行(−178)**,`is-open` 规则清零。核实 `<AssetTray>` / `<RunInspector>` 只在 `.canvas-inspector-content` 内渲染且永远带 `embedded`,故独立态的宽度/flex/边框、两处媒体查询里的独立浮层块、聚焦模式的隐藏规则全部为死代码 |

### 批次 2 · 节点解剖

| 项 | 状态 | 提交 | 备注 |
|---|---|---|---|
| B2-1 状态脊 | ● | (见下) | 原先已有 3px 内嵌色条,但只在 header 且编码的是**类别**。两个语义拆开:左侧全高边条给运行状态,类别色移到 header 顶部 2px 带。空闲时脊透明,静息节点保持干净 |
| B2-2 三列子栅格参数行 | ● | (见下) | 图像参数原是三个裸下拉并排 flex 平分且 `min-width: 0`,304px 节点里每个约 93px——截断的根源。改为标签+控件行式,用 `subgrid` 让控件列跨行对齐且不低于 `--node-control-min` |
| B2-14 标题禁止换行 | ● | (见下) | CSS 早已 `text-overflow: ellipsis`,但 JSX 没有 `title`——截断后无法看到全文。已补 |
| B2-9 进度发丝线 | ● | (见下) | 进度条从流式块移到 header 底边绝对定位,复用 border-bottom。进入运行态不再增加节点高度,图不会中途重排。进度文字(阶段/耗时/延迟提醒)保留在原位 |
| B2-7 端口语义 | ◐ | (见下) | 色相与形状已做:**修掉 `.wf-port-audio` 完全缺失的真 bug**(音频端口此前无填充色,读起来像禁用),并按基数编码形状(多输入=圆角方,单输入=圆)。**「填充=已连接」待补**,需要 `useNodeConnections` 逐端口订阅。顺带删掉 B1-1 误加的 `--port-any`——`PortKind` 只有四种,研究说的「五种」不适用本仓 |
| B2-3 由最长选项反推最小宽度 | ○ | | B2-2 落地后截断已消失,此项改为「验证 + 设下限」 |
| B2-4 … B2-13 | ○ | | |

### 批次 3 · 交互层

B3-1 … B3-18 全部 `○`

### 批次 4 · 资产库

B4-1 … B4-16 全部 `○`

---

## 8. 明确不做

- ❌ 不买 React Flow Pro——它不锁功能,只卖示例与去水印权。
- ❌ 不做正交/A\* 连线路由(Pro 示例用 libavoid)。我们是几十节点的浅层媒体 DAG,平滑边 + 用户放置的 reroute 解决 95% 的重叠问题。
- ❌ 不做变更即自动布局。会摧毁空间记忆,布局保持显式命令。
- ❌ 不换 canvas/WebGL 渲染器。我们的节点**就是**媒体预览,需要 `<img>`/`<video>`/`<textarea>`,DOM 正是选 React Flow 的理由。
- ❌ 不引入 Rete / litegraph / Baklava 作为依赖。
- ❌ 不做节点插件/扩展系统。第三方节点代码会击穿 I15 建立的隔离边界。
- ❌ 不引 `sharp`(会成为四依赖项目的第一个原生生产依赖:每平台约 10MB 预编译 + `asarUnpack` + 审计过的主进程多一层供应链面)。
- ❌ **绝不引 `ffmpeg-static`**(npm license 字段是 `GPL-3.0-or-later`,MIT 的 `fluent-ffmpeg` 包装器洗不白二进制条款)。
- ❌ 不给 300-400px 抽屉做虚拟化。真缩略图落地 + 分页 ≤100 之后它落在仓库既有规则的假设之内;虚拟化 24-60 个瓦片换来的是 Ctrl+F、`scrollIntoView` 和焦点正确性的丧失。
- ❌ 不做分层标签、嵌套集合、5 星评分、颜色相似度检索、人脸识别、时间轴滚动条。
- ❌ 不把视口变化写进撤销栈。平移缩放是导航不是编辑。
- ❌ 不加 jsdom(仓库规则 T7)。布局数学、选择归约、范围计算写成纯函数单测,其余交给 Electron smoke。
- ❌ 不为了让测试通过而改断言。

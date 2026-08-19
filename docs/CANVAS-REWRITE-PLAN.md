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
| B2-7 端口语义 | ● | `24ebdea` + (见下) | 三条编码全部落地。色相=媒体类型(**修掉 `.wf-port-audio` 完全缺失的真 bug**,音频端口此前无填充色,读起来像禁用);形状=基数(多输入=圆角方);填充=已连接(未连接为空心环,连接后实心并带光晕)。为读连接状态把 Handle 抽成 `PortHandle` 组件用 `useNodeConnections` 逐端口订阅,`title`/`aria-label` 一并带上连接条数。顺带删掉 B1-1 误加的 `--port-any`——`PortKind` 只有四种 |
| B2-10 校验错误与执行错误分离 | ● | (见下) | 两类错误此前共用 `.wf-error`,长得一模一样。校验类(分组不提供该模型——用户要去改)改为琥珀底 + `AlertTriangle` + `role="status"`;执行类(运行时失败,可能是 503/额度/内容过滤)保持红色 + `AlertCircle` + `role="alert"` |
| B2-5 参数单一真相源 | ● | (见下) | **不采用研究建议**。Langflow 的用户可配置 pin 机制适合开发者用户,不适合「想出张图」的普通客户;且两套控件读写同一 `node.data`,无数值分歧,害处是冗余不是正确性。落地:节点体保持唯一编辑位置,检查器参数区转只读摘要 + 「在节点上编辑」定位动作。行数据抽成 `canvasInspectorParameterRows` 纯函数(+5 测试),删掉 73 行重复编辑器与随之失效的 10 个 models 导入、3 个 kind 集合、`uniqueOptions`、`onPatch`/`onSettingsPatch` 两个 prop 及其在 `App.tsx` 的两个回调 |
| B2-6 pinned 持久化 | ⊘ | | 随 B2-5 方案调整取消。**批次 2 因此不再触碰持久化 schema**,先前声明的「唯一一处越界到保留层」消失 |
| B2-3 参数宽度下限 | ● | (见下) | B2-2 落地后截断已消失,故改为把不变量钉成断言而非再算一次宽度。`node-parameter-width.test.ts` 从 `theme.css` 读 `--node-control-min` 与 `--node-width-min`,断言所有渲染参数栅格的节点宽度不低于「边框+边距+标签轨+间隙+控件轨」;另把 router(224px)作为唯一低于 `--node-width-min` 的功能节点显式钉住,避免悄悄漂移 |
| B2-8 悬停才显露端口点 | ⊘ | | **前提不成立**。该建议针对 ComfyUI 那种「每个 widget 都可提升为输入」的可提升参数点;本仓端口是 `NodeDefinition.ports` 声明的真实媒体端口,每一个都是有意义的连接位。隐藏它们会让用户看不到能连哪里,是负优化。静息时的视觉噪音已由 B2-7 的空心环解决 |
| B2-4 标识符中段截断 | ● | (见下) | `identifier-display.ts` + 5 项测试。应用在空间确实紧张且值是次要信息的位置(多选节点列表的模型/ID、引用对话框)。**资产详情面板反向处理**:那里的目的就是给出精确值,原先 CSS 末段裁切让内容哈希被切掉尾巴且无法复制,改为换行显示全文——smoke 的「图片详情缺少稳定资产 ID」断言是对的,我第一版把它改坏了 |
| B2-11 缓存命中独立视觉 | ● | (见下) | **此前渲染层根本收不到这个事实**:`App.tsx` 在事件入口就把 `cached` 折叠成 `succeeded`,节点无从得知。新增运行时字段 `fromCache`(列入 `runtimeDataKeys`,不进持久化),事件与运行记录投影两条路径都写入,配 1 项测试钉住「重载后仍能区分缓存命中与新付费运行」。视觉为 slate 状态脊 + `已缓存` 标签 + 标题降为次级色 |
| B2-12 真 LOD | ● | (见下) | 摘要模式与迟滞本已存在,但阈值是硬编码 0.52。按 `minPx / (baseFont × √DPR)` 核算后发现**那个值只对 2x 屏成立**:DPR 1 应为 0.727,当前机器上 11px 文字要缩到 5.7px 才切摘要。改为按 `window.devicePixelRatio` 推导,迟滞改为入口 ×1.12。+3 测试,含「任何 DPR 下最小字号的物理像素恰好等于可读下限」 |
| B2-13 媒体节点可缩放 | ● | (见下) | 不只是挂个控件:`dimensions` 变更原本落在 `transient` 分支,只改视图不改文档,resize 会在下一次 undo/重开项目时静默弹回。新增 `resize-nodes` 命令 + reducer(锁定节点拒绝)+ 与拖拽同款的手势合并,再挂 `NodeResizer`(图片/视频锁宽高比,音频不锁,仅选中时显示)。+3 测试覆盖 undo/redo 往返、一次手势一条历史、锁定节点不可缩放 |

### 批次 3 · 交互层

| 项 | 状态 | 提交 | 备注 |
|---|---|---|---|
| B3-5 双击语义归位 | ● | (见下) | `zoomOnDoubleClick={false}`。此前双击空白既开快速创建**又**缩放画布,两个语义打架 |
| B3-7 选中层级 | ● | (见下) | `elevateNodesOnSelect` + `elevateEdgesOnSelect`,选中节点不再被未选中的邻居盖住 |
| B3-8 拖拽阈值 | ● | (见下) | `nodeDragThreshold={3}`。另修真缺陷:`PromptEditor` 只有 `nodrag` 没有 `nowheel`,提示词超出文本框高度后滚动会缩放画布而不是滚动内容。`nodrag/nowheel/nopan` 三个 className prop 本就是 React Flow 默认值,显式设置无意义,已不加 |
| B3-1 自定义 edgeTypes | ● | (见下) | 此前注册的是**零个**自定义边:没有悬停态、不按类型着色、命中区域只有 1.6px 描边宽。新增 `edges/WorkflowEdge.tsx`——18px 透明命中路径、悬停/选中加粗、按**源端口**推导媒体色(目标端口可接受多种类型,不能用来定色)。色调与中点抽成 `workflow-edge-model.ts` 纯函数 +5 测试 |
| B3-2 EdgeToolbar | ● | (见下) | 选中边时在中点浮出工具条:在此插入节点、删除连线。回调经 context 传入而非塞进 edge data,避免每次渲染把函数序列化进文档 |
| B3-3 改接连线 | ● | (见下) | 新增 `reconnect-edge` 命令,一次手势一条历史(而非删+连两步撤销)。校验时**排除被改接的那条边**,否则单容量目标端口会被它自己占用而拒绝改接。+2 reducer 测试 |
| B3-4 节点/选区右键菜单 | ● | (见下) | 此前右键节点**什么都不发生**(只有画布与连线有菜单)。新增 `onNodeContextMenu` + `onSelectionContextMenu`,四套菜单齐了。采用文件管理器约定:右键未选中节点只作用于它,右键选区内则作用于整个选区。菜单项集合抽成 `editor/context-menu.ts` 纯函数 +8 测试(T7:仓库无 DOM 环境,故断言数据而非渲染结果) |
| B3-6 连线引导 | ● | (见下) | 拖线时用 `useConnection()` 逐端口判定:能接的放大 1.35 倍并加光晕、不能接的降到 28% 透明度、起点端口用强调色标记。兼容性判定需要整图,故经既有的 `registerNodeChangeHandlers` 注入 `isPortCompatible`,而不是让端口组件自己去拿图 |
| B3-9 撤销粒度 | ● | (见下) | 拖拽(既有)、缩放(B2-13)、文本(既有 mergeKey)三类手势本已各自合并,唯独**合并窗口没有时限**:隔五分钟回来改同一个节点仍会并进上一条,一次撤销把两次编辑一起抹掉。加入 2500ms 时间窗。窗口刻意取大——中文 IME 逐词提交、词间停顿长,常见的 500ms 窗会把一句话碎成很多步 |
| B3-10 对齐与分发 | ● | (见下) | `editor/align.ts` 六种对齐 + 两轴均分间距,+11 测试。两个刻意的设计:居中按各节点自身宽高算(否则不同尺寸的节点中线不齐);均分按**间隙**而非中心(否则大小不一的节点看起来会挤成一团)。锁定节点参与包围盒计算但自身不动——这正是「锁一个、其余向它对齐」的用法。多选时才出现在选区工具条,均分需 ≥3 个 |
| B3-14 删除并重连 | ● | (见下) | `editor/bridge-edges.ts` +7 测试。只在媒体类型一致时接通,不会凭空造出端口不接受的连线;不重复已有连线;两端都被删时不接。桥接与删除是**同一条命令**,一次撤销同时还原节点与原始连线。顺带修 `handleKind` 对复数端口(`in:images`/`in:videos`/`in:audios`)返回 null 的缺口 +3 测试 |
| B3-17 框选修饰键 | ● | (见下) | `multiSelectionKeyCode="Shift"` + `panActivationKeyCode="Space"` |
| B3-11 辅助线吸附 | ● | (见下) | `editor/snap-guides.ts` +9 测试。边与中线都参与、每轴只取最近的一个候选(否则夹在两个节点中间会来回抖)、辅助线只跨越相关的两个盒子而不是横贯画布。**只在单节点拖动时生效**——多节点拖动没有单一可对齐的边,吸附其中一个会把用户已排好的相对位置剪切掉。用 `ViewportPortal` 渲染,随平移缩放跟随 |
| B3-18 搜索并跳转节点 | ● | (见下) | Ctrl/Cmd+F 打开查找面板,按名称/提示词/模型搜索,回车跳转。排序保证标题匹配永远压过提示词匹配(搜「输出」应先给输出节点,而不是每一个提到这两个字的提示词);提示词命中显示匹配处的上下文片段而不是开头。`editor/node-search.ts` +11 测试 |
| B3-15 拖节点到连线上插入 | ● | (见下) | 新增 `splice-node-on-edge` 命令(区别于既有的 `insert-node-on-edge`:节点已存在,只改接线)。命中判定用 `editor/edge-drop.ts` 的点到**线段**距离(不是无限直线,否则短边延长线上的节点会被误判),+7 测试。端口按媒体类型自动选;接不上时给中文提示而不是静默失败。悬停时目标连线加粗虚线 |
| B3-12 切线手势 | ● | (见下) | Ctrl/Cmd + 在空白处拖动划过连线即剪断,红色虚线笔迹跟随。笔迹按**画布坐标**记录,中途平移不会错位。线段相交判定(含共线相切)抽成 `editor/cut-gesture.ts` +11 测试 |
| B3-13 reroute 节点 | ○ 已评估暂缓 | | 见下方「已评估暂缓的两项」 |
| B3-16 旁路(bypass)语义 | ○ 已评估暂缓 | | 见下方「已评估暂缓的两项」 |

### 已评估暂缓的两项(B3-13 / B3-16)

**决策(2026-08-19):暂缓,不做。** 三条理由:

1. 两项都要动**持久化 schema 与主进程运行引擎**。批次 2 特意把 schema 改动收敛
   到零,批次 3 也一直没碰主进程;为一个能力破这条线需要更强的理由。
2. 它会改变用户看到的**运行结果与费用预估**——下游从「被跳过」变成「正常成功」。
   这类改动应独立成批,配自己的测试与真机验证,不适合塞在交互批次尾巴上。
3. 四项不满是「界面、节点、交互、资产管理」,bypass 不在其中,而资产库整整
   16 项都在。优先级清楚。

以下侦察结论保留,将来要做时不必重新论证:

**现有 `disabled` 走的是 skip,不是透传。** `canvas-run-engine.ts:305` 在预估
远程调用数时、`:562` 在实际执行时,都把 disabled 节点标记为 `skipped`;并且
`:303-304` 的 `upstreamSkipped` 会把**下游一并跳过**。所以今天没有任何透传路径。

真正的 bypass(节点不跑但把输入原样传给下游,用于临时摘掉链路中一步做 A/B,
例如 提示词 → 放大 → 输出 想看不放大的效果)需要三件事:

1. 持久化新增节点状态——**建模方式待定**:保留 `disabled` 再加独立的 `bypassed`,
   还是合成一个三态?
2. `canvas-run-engine.ts` 支持按媒体类型匹配的透传,并定义类型对不上时的行为
3. 下游状态语义变更(被跳过 → 正常成功),连带影响运行结果展示与费用预估

**B3-13 reroute 节点**技术上是 B3-16 透传能力的一个特例:单独做要为一个纯视觉
需求改执行引擎,不划算;与 B3-16 一起做则成本低得多。两项应一起做或一起不做。

### 批次 4 · 资产库

| 项 | 状态 | 提交 | 备注 |
|---|---|---|---|
| B4-1 修正截断搜索 | ● | | 新增 `electron/ai-asset-index.ts`:只走 readdir + lstat、**不读任何媒体字节**地枚举全部资产,三个 store 各加 `listOwnedIndex`。`listOwnedPage` 改为「索引全集 → 关联元数据 → 筛选 → 排序 → 切页 → 只水合当前页」。`total` 与 `hasMore` 现在是真实值;offset 上限从 500 提到 20000。元数据关联改用新增的 `metadata.getAll`(`getMany` 有 1500 个 id 上限,分块会把同一状态文件重复读多遍)。水合串行执行:每次读入一个受 store 上限约束的完整文件,128 MB 视频乘并发度是真实的内存尖峰;串行读至多 `limit` 个文件仍远优于旧路径的 500 个 |
| B4-7 选中模型显式化 | ● | | 删掉 `onMouseLeave` 里的清选中 + `focused.blur()`:指针划过网格会抢走键盘用户正在操作的卡片焦点,是无障碍缺陷。选中改为显式:激活打开、再次激活关闭、Esc 关闭、点空白处关闭,指针移动不再影响选中或焦点。状态迁移抽到纯模块 `canvas-v2/src/components/asset-selection.ts` 并单测。补 `aria-expanded` |
| B4-6 分面计数走全集 | ● | | 标签筛选面原先从 `page.items` 派生,翻一页就变。服务层在全集上算 `facets.tags`(含计数),**在标签筛选之前统计**,选中某个标签不会抹掉同级标签;其他筛选(视图/来源/搜索)仍会收窄计数,保持面板诚实。`CanvasAssetPage` 新增必填 `facets`,空页统一走新的 `emptyCanvasAssetPage()`。服务侧计数上限 64 项以免 DTO 无界增长 |
| B4-2 缩略图管线 | ● | | 新增 `asset-thumbnail.ts`(纯:URL/尺寸/格式)、`asset-thumbnail-store.ts`(磁盘缓存,原子写)、`asset-thumbnail-service.ts`(编排,串行队列 + 同资产在途去重)。**计划里的 `createImageBitmap` + `OffscreenCanvas` 跑 `utilityProcess` 不可行**:utilityProcess 是 Node 环境(带 Electron `net`),没有 Blink,两个 API 都不存在;要保留它们只能开隐藏 `BrowserWindow`,等于凭空多一个渲染面。改用 Electron 自带的 `nativeImage`(同一批 Chromium 解码器,主进程内,同样零新依赖),代价是同步执行,所以生成排在并发度 1 的队列后面 |
| B4-3 缩略图独立协议主机 | ● | | `xingmang-asset://thumb/<version>/<image\|video>/<assetId>`,响应头 `public, max-age=31536000, immutable`。资产 ID 是内容寻址、版本段在路径里,所以响应不可能就地过期;版本一升就整代失效。路径解析 `parseAssetThumbnailPath` 只认「版本/媒体类型/43 位 ID」三段,穿越与畸形 ID 根本进不到 store。媒体类型只决定问哪个 store,归属仍由 store 证明 |
| B4-4 视频封面帧 | ● | | 首选 `nativeImage.createThumbnailFromPath`(Windows/macOS,正是本产品的两个平台)。**回退已补齐**:平台缩略图提供方对某些编码没有处理器,那时静帧根本不存在,瓦片以前只能显示灰底占位。现在由 `canvas-v2/src/library/video-cover.ts` 在渲染层抓一帧——**离屏 `<video>` + `OffscreenCanvas`,seek 到 `min(1.0, duration*0.1)` 而不是 0**(首帧多半是黑场或淡入),转成 JPEG data URL。抓完立刻 `src=''` + `load()` 卸掉解码器。与 B4-5 不冲突:这个元素从不进 DOM,且全局队列保证同一时刻只有一个 |
| B4-5 停止每瓦片挂 video | ● | | 网格里**一个 live media 都没有**:播放器只存在于详情面板(B4-9),`NodeLibrary` 素材条整条改静帧。封面帧回退的离屏元素受同一约束——`createVideoCoverCache` 并发度 1、同源在途去重、失败结果也记住(否则每次滚动都重试一个解不开的文件)、缓存条目有上限(每条都是内联图)。**悬停擦除雪碧图仍不做**:多帧抽取要按任意时间戳 seek 出几十帧,离屏方案下等于把一整段视频解码进内存,而通用方案 ffmpeg 的 npm 包是 GPL-3.0-or-later,已排除 |
| B4-8 多选 | ● | | 选中从单个 id 换成 `{ ids: Set, anchor }`:Ctrl/Cmd 切换、Shift 从锚点拉范围(锚点不动,范围可反复重画)、Ctrl+A 全选当前页、右键命中已选区时保留整个选区。**「展开」与「选中」拆开**——详情面板只在恰好选中一个时出现,`is-selected` 只画描边、`is-expanded` 才占整行,否则拉一个范围会把每张卡都撑成整行 |
| B4-9 详情面板移出卡片 | ● | | 详情改为停靠在网格下方(`.asset-tray-detail`,`max-height: 42%` 自带滚动),瓦片不再原地长高,后面的瓦片不会被推走。顺带把 B4-5 做到底:播放器只存在于详情面板,**网格里一个 live media 都没有**(旧写法是「展开的那张挂播放器」) |
| B4-10 键盘导航 | ● | | roving tabindex(整个网格一个 Tab 停靠点,方向键在内部移动,列数从实时 `grid-template-columns` 量取而不是写死——网格是响应式的且音频瓦片整行跨列)、Home/End、`.` 收藏、`/` 聚焦搜索、查看器 `←/→` 翻页(焦点在 media 元素上时让位给进度条) |
| B4-11 骨架瓦片 + 高度稳定 | ● | | 「正在读取」行改成只读给屏幕阅读器的 live region(它自己占一行、来回出现正是抖动源)。**骨架只在没东西占位时出现**(首次加载/空结果):已在屏的旧瓦片是最好的占位物,尺寸天然正确,而且换成骨架会把正在用键盘操作它的人的焦点摧毁(实测:换掉后连按两次 `.` 第二次落空)。加载中旧瓦片降透明度并禁指针,只说明「这是旧的」,不移动任何东西 |
| B4-12 五种空状态 | ● | | `asset-empty-state.ts` 按「用户最近做了什么、最容易撤销什么」排优先级:搜索 → 筛选(标签/类型/来源) → 视图(收藏/最近) → 素材库本身为空。每种给标题 + 说明 + **恰好一个**下一步按钮。收藏/最近空态给的是「查看全部」而不是「导入」——导入进的是全部,导完这个视图还是空的 |
| B4-13 密度三档 | ● | | 72/96/132px 三档,网格改 `auto-fill minmax(Npx, 1fr)`,持久化在**全局** localStorage(`asset-density.ts`)而不是 `canvas-ui-preferences`(那是按项目存的):素材库在每个项目里都是同一个库。附带修掉一个被密度暴露出来的老缺陷——瓦片操作行(5 个按钮 ≈132px)比密集瓦片还宽,只锚右边时会跑出素材栏、被画布吃掉点击;改成用**容器查询**按瓦片实际宽度逐个卸掉次要按钮(重命名 → 更多 → 放大),被卸掉的都在详情面板/双击/右键里还有入口 |
| B4-14 筛选面重构 | ● | | 三行(搜索+两行 select / 标签条)压成一行工具行:搜索框 + 「筛选与排序」弹层(类型/来源/排序/标签,带生效数角标) + 密度开关。生效中的筛选改成可移除标签行,只在真的有筛选时占位。实测回收 ~76px(有标签时 ~106px)。弹层关闭用 `pointerdown` 而不是 `click`——select 的下拉会吞掉那次 click |
| B4-15 软删除 + 回收站 | ● | | 删除只写 `deletedAt`(元数据 store 升到 v3,v2 仍可读),文件一动不动;回收站是第四个快速视图,按删除时间倒序。撤销做在两处:删除后 10 秒的 toast(最省事的那次撤销),以及回收站里的「恢复」(想起来晚了的那次)。**只有「彻底删除」才碰文件,且只在这一步做引用阻断**——软删除阶段阻断引用会把「先清掉、以后再说」这条最常见的路堵死。彻底删除走 `shell.trashItem` 交给系统回收站,不做 `unlink`:本程序判断不了用户是不是还想要那个文件。三个新宿主通道各自先 `readOwned` 证明归属再动元数据(I5),文件路径由主进程从 store 解析,画布只递资产 ID(I15)。`Delete` 键在普通视图删除、在回收站里恢复——破坏性的那半必须显式点 |
| B4-16 提示词优先 + 复制 + 找相似 | ● | | 提示词此前**根本没有存过**(素材侧只有 provider 改写后的 `revisedPrompt`,且从未真正落过盘),所以先在生成时把用户提交的原文写进元数据(v4,兼容读 v1/v2/v3),详情面板把它排在最前并可一键复制,资产 ID 同样给复制按钮。搜索纳入提示词——那是几周后唯一还记得住的线索。「找相似」三条:同提示词(精确匹配,子串命中的是另一件活儿)、同一次运行、同来源节点;后两条由 `canvas-run-store.listAssetIdsByLineage` 反查成 ID 集合再交给素材库当限制条件,**在分页之前生效**,否则 total 又会像 B4-1 那样说谎。三个筛选都出可移除标签,空结果走「清除筛选」空态。顺带修掉 B4-15 的一个真缺陷:`parseCanvasAssetQuery` 当时没放行 `view: 'trash'`,回收站在真实 IPC 上根本到不了服务层(冒烟测试用的是桩 host 所以没暴露);同时把 offset 上限从 500 提到 20000,否则 B4-1 拆掉的截断在解析层又被装回去了。**视频提示词已补齐**:视频任务可跨进程重启续跑,记录是重启后唯一还在的东西,所以提示词进了 `ai-video-task-store`(v2,兼容读 v1——升级前提交的任务照样能续,只是那支片子没有提示词)。一处需要留意的取舍:该文件原有一道「不得出现凭据或远程地址」的粗扫描,而用户提示词里引一个 URL 完全正常,照旧扫描等于让一条提示词把整份待恢复任务判成损坏。改成扫描**剔除提示词之后**的投影——提示词是用户写的文本、从不会被请求,且早就在素材元数据里逐字存着;其余字段(含 group/model/taskId)照扫不误,并配了「篡改 group 成 URL 仍然拦下」的测试 |

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

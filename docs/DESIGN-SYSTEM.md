# 设计系统(Figma)

星芒AI管理工具的设计真相源。**全部色值、间距、字号、圆角、阴影都从 `src/styles.css` 逐条提取**(品牌色一处例外,见下),不是重新设计的一套——目的是让设计稿与代码永远对得上。

**Figma 文件**:`星芒AI · 设计系统`
https://www.figma.com/design/Qdl99KsjBlx7SfMFVHaIAb

`fileKey` = `Qdl99KsjBlx7SfMFVHaIAb`(agent 调 Figma MCP 时要用)

---

## 已建成(2026-08-24 第二轮更新)

### 变量 157 个(两个集合)

| 集合 | 数量 | 模式 | 内容 |
|---|---|---|---|
| `Primitives` | 137 | 单模式 Value | 86 色(原 65 + 本轮新增 21)+ 24 间距 + 8 圆角 + 12 字号 + 5 字重 |
| `Semantic` | 20 | **Light / Dark 双模式** | 语义别名,Light 指向浅色原子、Dark 指向暗色原子 |

**待办 1 已完成**:原先受免费版限制拆开的 `Semantic · Light` / `Semantic · Dark` 两个平行集合,已合并为单一 `Semantic` 集合的 Light/Dark 双模式(默认 Light),旧 Dark 集合已删除(删除前已确认画布零绑定)。切模式即整体换肤。

**每个变量都挂了对应的 CSS 变量名**(code syntax,如 `var(--color-accent)`),开发看稿即知该用哪个 var()。两类例外:① 本轮新增的 21 个原子(见下)在 CSS 里是硬编码 hex,没有对应 CSS 变量,故不设 code syntax;② 8 个 `provider/*` 品牌变量的来源是 `src/provider-meta.ts` 的常量而非 CSS 变量,原先误标的 `var(--provider-*)` 已摘除。

**品牌色修正**:上一轮把 codex / gemini / grok 三家的色值互相错位了(同一组值、错误分配)。本轮已按 `provider-meta.ts` 修正:codex `#087b68`、grok `#323640`、gemini `#5969c7`(tint 同步)。

**本轮新增 21 个原子**(全部来自 styles.css 里的硬编码 hex,组件要绑变量所以先补齐;**代码侧 token 化是待还的债**):
`danger/button-bg|button-border|button-bg-hover`(危险按钮)、`success/mark` `danger/mark-text|mark-bg`(状态圆标)、`pill/ok|missing|error|running|idle 的 text+bg 共 10 个`(版本徽章)、`text/card-heading|card-caption|code-meta|field-label|field-hint`(卡片与表单文字)。

### 样式

- **文字样式 12 个**:`Display/余额数字`(26)→ `Caption/元信息`(10)。等宽字体替身用 **Cascadia Mono**(代码为 Consolas)
- **阴影样式 4 个**:`Elevation/1-4`,对应 `--shadow-sm/md/lg/xl`

### 页面(12 页)

```
封面与说明            (已完成)
基础规范              (空,内容待建:色板/字阶/间距条)
——— 组件 ———          (分隔页)
模板库 · Simple DS    ✅ 完整社区模板目录(见下)
桌面场景 · OS 模板     ✅ 用户选定的桌面场景模板索引(见下)
Button · 按钮         ✅ 组件集 9 变体
Badge · 版本徽章       ✅ 组件集 6 变体
Card · 卡片           ✅ 单组件 + Title/Body 文本属性
Input · 输入框         ✅ 组件集 3 变体 + Label/Value 文本属性
StatusMark · 状态标记  ✅ 组件集 3 变体(SDS 图标实例)
NavItem · 侧边栏项     待建(页内有规格说明)
CliCard · 工具状态卡   待建(页内有规格说明,原子已齐)
```

### 已建组件(全部绑定变量,零硬编码色值)

| 组件 | 变体 | 对应代码 | 绑定要点 |
|---|---|---|---|
| `Button` | Kind(Primary/Secondary/Danger)× State(Default/Hover/Disabled) | `.primary/.secondary/.danger-button` | 高 38、padding space/14、圆角 radius/7;Primary 绑 `color/accent(-hover)`,Danger 绑新增 `danger/button-*`;Disabled 52% 不透明度;主按钮投影为字面量(CSS 是 color-mix 派生,effect 无法表达) |
| `Badge` | State ×6(Default/Running/Update/Idle/Missing/Error) | `.version-pill` | padding 3×6、radius/4、text-xs;Update 态绑语义 `surface/warning-soft`+`caution/text` 可随暗色翻转,其余绑 `pill/*` 原子 |
| `StatusMark` | State ×3(Installed/Missing/Failed) | `StatusMark.tsx` + `.status-mark` | 19×19 圆,图标是 **Simple DS 库的 Check/X/Alert triangle 实例**(代码用 lucide-react,几何一致);Failed 走语义 warning |
| `Card` | 单组件 | `.cli-card` 壳 | surface/panel + border/strong + radius/7 + space/12,Title/Body 为文本属性插槽 |
| `Input` | State ×3(Default/Focus/Error) | `.field` | 标签/输入框/提示三段;Focus 绑 `focus-ring` 边框 + 18% 焦点环;Error 行绑语义 `color/danger`;值文本 Cascadia Mono |

组件页布局:每页 = 文档卡(标题+规格说明)+ 变体网格(列=State、行=Kind,带表头标签),组件集均写了 description。

### 模板库 · Simple DS(应用户要求引入的完整社区模板)

文件已订阅 **Figma 官方 Simple Design System**(CC BY 4.0,400+ 组件,自带明暗模式,配套开源代码 github.com/figma/sds)。`模板库` 页实例化了 21 个核心组件作目录:按钮 6 种 / 表单 7 种 / 展示 7 种 / Dialog。**完整清单在资产面板(Assets → Simple Design System)搜索拖用**。

分工约定:**要与现有界面像素对齐 → 用本文件的代码对齐组件;画新界面/通用 UI → 可直接用 SDS 模板组件**(SDS 走它自己的变量体系,与 styles.css 无对应关系,别混着绑)。文件还订阅着 M3、Apple 各平台官方 kit 共 8 个库,按需取用。

### 桌面场景 · OS 模板(用户选定)

用户从社区复制了 **Desktop app template(macOS + Windows 11)** 到自己草稿:
`fileKey = NoWU3ehd2t5olCeHQj4nZO`,内含 4 套完整 OS 场景组件(macOS 菜单栏+程序坞 / Win11 任务栏,各明暗两版,窗口区留空)+ 应用图标栅格。用途:把星芒界面放进 Window 空窗区,产出官网图/README 图。该模板无变量、无控件,与组件体系互补。

`桌面场景` 页放了索引与用法;**云端容器网络无法跨文件搬运图片资产**(figma.com 直连被代理拦截),所以场景没有内嵌进本文件——要合体的话在 Figma 里把模板文件 Publish library 后从资产面板拖用,或直接在模板文件里作图。

---

## 必须知道的约定

**1. 字体是替身。** 设计稿用 `Noto Sans SC`(无 SemiBold,600/650 字重一律用 Medium 替),等宽用 `Cascadia Mono`。**生产环境实际渲染是 `--font-sans` / Consolas 那一串**,看稿别照替身字体调间距。

**2. 语义层双模式已就位。** 组件绑语义变量的部分(accent/danger/warning/表面色/文字色)切 Dark 模式即翻转;绑 `pill/*`、`danger/mark-*` 等新增原子的部分**不会翻转**——因为代码里这些色的暗色版也是散落的硬编码(`:root[data-theme="dark"] .version-pill` 等),两侧一起 token 化后才能接进语义层。

---

## 待办(更新后)

1. ~~合并明暗模式~~ ✅ 已完成
2. ~~拆页~~ ✅ 已完成(组件各占一页 + 两个模板页)
3. **建组件**:Button / Badge / StatusMark / Card / Input ✅;**NavItem、CliCard 待建**(规格在各自页面与本文档,原子全部就绪;通用场景可先用 SDS 模板组件)
4. **基础规范页内容**:色板、字阶、间距条(页面还是空的)
5. **Code Connect**:把 Figma 组件映射到 `src/components/` 真实组件
6. **代码侧 token 化欠债**:21 个新增原子对应的硬编码 hex(危险按钮/状态圆标/版本徽章/卡片表单文字)与它们的暗色对应值;外加上一轮记录的 `#17191b`/`#e7eaeb`(Figma 侧已是 `dark/surface-page`/`dark/text-base`,代码侧未补)

### 已提取待建的组件规格

- **NavItem**(`.nav-item`,`styles.css:1628`):高 34、padding 0 10、gap space/10、圆角 radius/7;Default `text/secondary`;Hover `text/primary`+`surface/raised`;Active `nav/active`+`surface/accent-soft`+左侧 2px accent 内嵌条 + Medium
- **CliCard**(`.cli-card`,`styles.css:4818`):Card 壳 170 高;顶行 36px 图标(radius/8、`provider/*-tint` 底)+ 名称(13/Medium,`text/card-heading`)/公司(10,`text/card-caption`)+ Badge;元信息行等宽包名(`text/code-meta`)+ StatusMark;按 Provider 四变体组装

---

## 给接手 agent 的话

动手前必读 Figma 两个官方技能文档(`skill://figma/figma-use/SKILL.md` 与 `skill://figma/figma-generate-library/SKILL.md`):颜色 0-1、写文字先 `loadFontAsync`、切页只用 `setCurrentPageAsync` 且每次调用至多一次、每次调用 ≤10 个逻辑操作、必须 `return` 创建的 node id、`use_figma` 绝不并行。

**别把变量重建一遍**——先按名字查(`getLocalVariablesAsync`,键用 `name@collectionId`),存在就跳过。集合 id:Primitives `VariableCollectionId:2:2`(模式 `2:0`)、Semantic `VariableCollectionId:4:4`(Light `4:0` / Dark `12:0`)。

已知坑一则:在同一节点上"创建后再改绑" fill 变量偶发渲染失效(数据正确但渲染成黑,克隆体正常)。修法:克隆一个正常变体、改绑、换入组件集、删坏节点。本轮 Button 的 Primary Default/Disabled 两个变体都是这么修好的。

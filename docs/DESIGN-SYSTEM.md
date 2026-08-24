# 设计系统(Figma)

星芒AI管理工具的设计真相源。**全部色值、间距、字号、圆角、阴影都从 `src/styles.css` 逐条提取**,不是重新设计的一套——目的是让设计稿与代码永远对得上。

**Figma 文件**:`星芒AI · 设计系统`
https://www.figma.com/design/Qdl99KsjBlx7SfMFVHaIAb

`fileKey` = `Qdl99KsjBlx7SfMFVHaIAb`(agent 调 Figma MCP 时要用)

---

## 已建成(2026-08-24)

### 变量 156 个

| 集合 | 数量 | 内容 |
|---|---|---|
| `Primitives` | 116 | 65 色(浅色 35 / 暗色 22 / 四工具品牌色 8)+ 24 间距 + 8 圆角 + 12 字号 + 5 字重 |
| `Semantic · Light` | 20 | 语义别名,指向 Primitives |
| `Semantic · Dark` | 20 | 同名同结构,指向暗色 Primitives |

**每个变量都挂了对应的 CSS 变量名**(Figma 的 code syntax,如 `var(--color-accent)`),开发看设计稿时能直接读出该用哪个 CSS 变量,不用猜。

原子层 scopes 一律设为空(不污染属性选择器),语义层按用途设 `FRAME_FILL` / `TEXT_FILL` / `STROKE_COLOR` / `GAP` / `CORNER_RADIUS`。

### 样式

- **文字样式 12 个**:`Display/余额数字`(26px)→ `Caption/元信息`(10px),覆盖标题三级、正文三档、标签两档
- **阴影样式 4 个**:`Elevation/1 选中态` / `2 卡片` / `3 弹窗` / `4 引导层`,对应 `--shadow-sm/md/lg/xl`

### 页面

`封面与说明` / `基础规范` / `组件库`(封面页已完成)

---

## 两条必须知道的约定

**1. 字体是替身。** 设计稿用 `Noto Sans SC`,因为 Figma 里没有 Segoe UI 和微软雅黑(Windows 系统字体)。**生产环境实际渲染仍是 `--font-sans` 那一串**,看稿时注意字宽会有细微差异,不要照着替身字体去调间距。

**2. 明暗拆成了两个平行集合**,而不是同一集合的双模式。这是免费版 Figma「每集合仅 1 个模式」限制下的变通。**账号已升专业版,这条限制没有了**——下一步应当合并成一个 `Semantic` 集合的 Light/Dark 双模式,再删掉两个旧集合。

---

## 待办

1. **合并明暗模式**(见上,升专业版后即可做)
2. **拆页**:专业版不限页数,组件应各占一页
3. **建组件**:按钮 / 徽章 / 卡片 / 输入框 / 四工具状态卡 / 侧边栏项——全部绑定到已建好的变量,不许硬编码色值
4. **Code Connect**:把 Figma 组件映射到 `src/components/` 的真实组件

### 已提取的组件规格(来自 styles.css,建组件时照这个来)

- **按钮**(`.primary-button` / `.secondary-button` / `.danger-button` 共享基座,`styles.css:2935`):高 38px、padding `0 14px`、圆角 `--radius-7`、字号 `--text-base`、字重 `--font-weight-semibold`、图标与文字间距 `--space-7`
  - 主要:白字 + `--color-accent` 底 + `0 3px 8px rgba(21,127,170,.14)` 投影
  - 次要:`#525a68` 字 + `--surface-panel` 底 + 1px `--border-control` 边框
  - 危险:`--color-danger-icon` 字 + `#fff7f7` 底 + 1px `#f2d6d8` 边框
- **状态标记**(`.status-mark`,`styles.css:3324`):19×19 圆形,三态 `installed` / `missing` / `failed`

---

## 顺带查出的代码缺口

暗色主题的**页面底色 `#17191b`** 与**基础文字色 `#e7eaeb`** 是硬编码在 `styles.css` 的 `:root[data-theme="dark"]` 里的,没有 token 化——其余颜色都规规矩矩走变量,唯独这两个漏了。Figma 侧已补为 `dark/surface-page` 与 `dark/text-base`,**代码侧尚未补**,是一笔可以顺手还掉的小债。

---

## 给接手 agent 的话

Figma 的写操作有官方规程,**动手前必须先加载它的两个技能文档**(`skill://figma/figma-use/SKILL.md` 与 `skill://figma/figma-generate-library/SKILL.md`),里面有一堆不遵守就会静默出错的规则:颜色用 0–1 而非 0–255、写文字前必须 `loadFontAsync`、切页只能用 `setCurrentPageAsync`、每次调用最多约 10 个逻辑操作、每次都要 `return` 创建出的 node id。

**别把变量重建一遍**——先按名字查,存在就跳过。

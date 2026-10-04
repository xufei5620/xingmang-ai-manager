# 20 · 组件代码契约（React）

`02-components.md` 说的是组件长什么样、什么时候用；这份说的是**代码里怎么写**。目录 `src/renderer-v2/ui/`，所有组件从 `ui/index.ts` 统一导出，页面只能 `import { Button } from './ui'`。

**目录形态（2026-09-19 定案，R-B3）：v2 采用集中式实现文件，不是一个组件一个文件夹。** 组件按职责分入 `core.tsx`（按钮、徽标、卡片、行、表格、页头、工具条）、`fields.tsx`（输入类）、`modal.tsx`（Dialog / Confirm / Drawer）、`floating.tsx`（Menu / Popover / Tooltip）、`feedback.tsx`（Notice / Toast / Progress / Skeleton / Empty）、`brand.tsx`（BrandIcon / Logo）、`guidance.tsx`（Coachmark 等），`shared.tsx` 放公共类型与 Context，`components.tsx` 再把它们汇成一层，`index.ts` 负责挂 token 与组件样式并对外导出。测试集中在 `components.test.tsx`、`provenance.test.ts` 与 `browser-check.mjs`，组件预览在 `gallery.html`，不使用 `*.stories.tsx`。

`reference/20-component-api.md` 是设计包原稿的只读副本，里面「一个组件一个文件夹：`Button/Button.tsx`、`Button.stories.tsx`、`Button.test.tsx`、`index.ts`」的目录要求未被采用——曾按它建过 32 个只含一行转发的 `ui/<Name>/index.ts`，代码里 0 处 import，已随 R-B3 删除。

## 通用约定

- 组件只接受 **语义 props**，不接受 `className` / `style`（防止页面私自改样式）。唯一例外：布局容器 `Stack` / `Grid` 接受 `gap` / `columns`。
- 尺寸只有 `size: 'md' | 'sm' | 'xs'`（32 / 28 / 24）。
- 颜色语义只有 `tone: 'ok' | 'warn' | 'bad' | 'accent' | 'neutral'`。
- 图标传组件不传字符串：`icon={Download}`（lucide）；品牌图标用 `<BrandIcon tool="claude" size={24} />`。
- 每个组件必须有 `data-testid` 透传 prop `testId`。
- 每个组件必须能仅用键盘完成全部操作；焦点环用 `--accent`。
- 文案通过 `t('key')` 传入，组件内不写死中文。

## 组件清单与 props

| 组件 | 主要 props | 备注 |
|---|---|---|
| `Button` | `variant: primary\|secondary\|ghost\|danger\|accent\|balance` · `size` · `icon` · `iconRight` · `loading` · `disabled` · `onClick` · `kbd?` | `balance` 变体内部读余额档位决定颜色 |
| `Pill` | `tone` · `dot?: boolean` · `children` | 只展示，不可点 |
| `Card` | `title?` · `meta?` · `actions?: ReactNode` · `collapsible?` · `defaultOpen?`（默认 true）· `onOpenChange?` · `padding: 'none'\|'md'` | 有 `title` 才渲染 card-head；可折叠的卡要记住收起时，页面用 `defaultOpen` 和 `onOpenChange` 自己存（首页「还可以装」）；标题不折行。`meta` 是超过 24 个字的字符串时放进卡片第一行单独成段（`xm-card-lead`），短的跟在标题后面、放不下打省略号。卡片里直接放 ListRow / ToolRow / 表头时，行和分隔线通到卡片两边，第一行上面不画线 |
| `ToolRow` | `tool: ToolId` · `status: ToolStatus` · `version?` · `model?` · `extraAction?` · `primaryAction` · `menu?: MenuItem[]` · `menuLabel?` · `progress?: number` | 六列固定网格；`menuLabel` 是「…」的鼠标提示和读屏名，缺省「更多操作」，首页工具行写「配置和更多操作」 |
| `ListRow` | `icon` · `title` · `badge?` · `desc?` · `descMono?` · `meta?` · `actions` · `off?` · `anchor?` · `onOpen?` · `openTestId?` | 通用行；`anchor` 写成 `data-anchor`，供别处跳来时翻到这一行（检查页按检查项代码）。给了 `onOpen` 整行都能点（标题是按钮，键盘和读屏从它进），鼠标停上去变色；`actions` 里的按钮各管各的，不触发整行 |
| `SessionRow` | `tool` · `title` · `path` · `model` · `count` · `when` · `archived?` · `onOpen` | |
| `Segment` | `options: {value,label,icon?,disabled?}[]` · `value` · `onChange` | ≤ 5 项 |
| `Switch` | `checked` · `onChange` · `label?` · `description?` | 切换即保存 |
| `Input` / `Select` / `Textarea` | 标准受控 props + `error?: string` · `hint?` · `mono?` · `password?`（带显隐） | |
| `SearchInput` | `value` · `onChange` · `placeholder` | 带图标，宽 240 |
| `Dialog` | `open` · `title` · `subtitle?` · `icon?` · `width: 480\|640` · `onClose` · `footer` · `dirty?`（有草稿时点遮罩不关） · `initialFocus?` · `headless?` | 只能有一个打开；`headless` 不画标题行和关闭按钮（标题只给读屏，Esc 和点遮罩照样关），框顶固定在窗口高度约 1/6 处，内容变高只往下长——目前只给命令面板用 |
| `Confirm` | `title` · `body` · `okLabel` · `danger?` · `requireAck?` · `onOk` | Dialog 特化 |
| `Drawer` | `open` · `title` · `icon?` · `footer` · `onClose` | 右侧 420，从顶栏下面到状态栏上面；非模态：背后不罩、不模糊，点另一行换内容，Esc 关；footer 按钮从左往右排、主按钮在最左，放不下换行 |
| `Notice` | `tone` · `icon` · `title` · `body` · `actions` · `onDismiss` · `progress?` | 同时只显示一张；`tone='bad'` 一律红圈 ×、`'warn'` 一律橙色三角，`icon` 只对一般说明生效；嵌在页面里只留细边框，浮在角上的（开机提示、更新通知）由外壳加阴影 |
| `Toast` | 通过 `useToast().show(text, tone?)` 调用 | 2.4s，≤ 3 条；做成了的结果一律走它，不挂在页顶（带「打开所在位置」的导出结果除外，要给人点） |
| `Menu` | `items: {label,icon?,danger?,onSelect}[] \| 'divider'` · `anchor` | |
| `Popover` | `anchor` · `title?` · `children` · `onClose` | 帮助 / 公告 / 账号切换 |
| `Empty` | `icon` · `title` · `description` · `action?` | `action` 里有两颗按钮时一样大、间距 8 |
| `Progress` | `value` · `tone?` · `label?` | |
| `Skeleton` | `rows?: number` | 列表加载 |
| `Tabs` | `items` · `value` · `onChange` | 弹窗页签 / 账号页签 |
| `Table` | `columns` · `rows` · `rowKey` · `onRowClick?` · `empty` | 卡片内自动横向滚动 |
| `PageHead` | `title` · `lead` · `actions?` | |
| `Toolbar` | `left` · `search?` · `right?` | |
| `SettingRow` | `title` · `description` · `control` · `anchor?` | `anchor` 写成 `data-anchor`，取 `settingsItems` 里那一行的 id，顶部搜索靠它翻到这一行并亮一下 |
| `BrandIcon` | `tool: ToolId \| model: string` · `size` · `variant: tile\|inline\|xs` | 内部映射 lobehub / simple-icons |
| `Logo` | `kind: micro\|symbol\|horizontal\|wordmark` · `height` | 内部按主题选深浅文件 |
| `Kbd` | `keys: string` | 自动按平台把 ⌘ 换成 Ctrl |

## 状态 hooks（页面只能通过这些拿数据）

```
useTools()          → { tools, install(id), launch(id), configure(id) }
useBalance()        → { balance, tier, hint, daysLeft }
useAnnouncements()  → { list, unread, markRead(id), pinnedUnread }
useUpdate()         → { phase, percent, check(), download(), install() }
usePlatform()       → { os, caps: { tray, notifications, desktopInstall, nodeInstall } }
useAccount()        → { user, accounts, switchTo(id), logout() }
```
组件树里不直接调 IPC；IPC 全部封装在 `features/*/api.ts`。

## 主题与 token 接入

```ts
import '@/styles/tokens.css'   // 全局一次
document.documentElement.dataset.theme = 'dark' | 'light'
document.documentElement.dataset.os = 'win' | 'mac' | 'linux'
```
组件 CSS Modules 里只允许 `var(--…)`；lint 规则 `no-hardcoded-color` 在 CI 里跑，出现十六进制色值直接失败。

## Story 要求

每个组件的 stories 必须覆盖：全部变体 × 全部尺寸 × 默认 / hover / focus / disabled / loading（有的话）× 暗 / 亮主题。组件检阅页（`prototype/components.html`）里的 45 项与 stories 一一对应，编号 V3-001…045 写在 story 标题里。

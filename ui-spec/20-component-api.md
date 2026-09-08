# 20 · 组件代码契约（React）

`02-components.md` 说的是组件长什么样、什么时候用；这份说的是**代码里怎么写**。目录 `src/renderer-v2/ui/`，一个组件一个文件夹：`Button/Button.tsx`、`Button.stories.tsx`、`Button.test.tsx`、`index.ts`。所有组件从 `ui/index.ts` 统一导出，页面只能 `import { Button } from '@/ui'`。

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
| `Card` | `title?` · `meta?` · `actions?: ReactNode` · `collapsible?` · `padding: 'none'\|'md'` | 有 `title` 才渲染 card-head |
| `ToolRow` | `tool: ToolId` · `status: ToolStatus` · `version?` · `model?` · `extraAction?` · `primaryAction` · `menu?: MenuItem[]` · `progress?: number` | 六列固定网格 |
| `ListRow` | `icon` · `title` · `badge?` · `desc?` · `descMono?` · `meta?` · `actions` · `off?` | 通用行 |
| `SessionRow` | `tool` · `title` · `path` · `model` · `count` · `when` · `archived?` · `onOpen` | |
| `Segment` | `options: {value,label,icon?,disabled?}[]` · `value` · `onChange` | ≤ 5 项 |
| `Switch` | `checked` · `onChange` · `label?` · `description?` | 切换即保存 |
| `Input` / `Select` / `Textarea` | 标准受控 props + `error?: string` · `hint?` · `mono?` · `password?`（带显隐） | |
| `SearchInput` | `value` · `onChange` · `placeholder` | 带图标，宽 240 |
| `Dialog` | `open` · `title` · `subtitle?` · `icon?` · `width: 480\|640` · `onClose` · `footer` · `dirty?`（有草稿时点遮罩不关） · `initialFocus?` | 只能有一个打开 |
| `Confirm` | `title` · `body` · `okLabel` · `danger?` · `requireAck?` · `onOk` | Dialog 特化 |
| `Drawer` | `open` · `title` · `icon?` · `footer` · `onClose` | 右侧 420 |
| `Notice` | `tone` · `icon` · `title` · `body` · `actions` · `onDismiss` · `progress?` | 同时只显示一张 |
| `Toast` | 通过 `useToast().show(text, tone?)` 调用 | 2.4s，≤ 3 条 |
| `Menu` | `items: {label,icon?,danger?,onSelect}[] \| 'divider'` · `anchor` | |
| `Popover` | `anchor` · `title?` · `children` · `onClose` | 帮助 / 公告 / 账号切换 |
| `Empty` | `icon` · `title` · `description` · `action?` | |
| `Progress` | `value` · `tone?` · `label?` | |
| `Skeleton` | `rows?: number` | 列表加载 |
| `Tabs` | `items` · `value` · `onChange` | 弹窗页签 / 账号页签 |
| `Table` | `columns` · `rows` · `rowKey` · `onRowClick?` · `empty` | 卡片内自动横向滚动 |
| `PageHead` | `title` · `lead` · `actions?` | |
| `Toolbar` | `left` · `search?` · `right?` | |
| `SettingRow` | `title` · `description` · `control` | |
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

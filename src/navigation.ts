import {
  ArchiveRestore,
  BookOpen,
  Blocks,
  Bot,
  Gauge,
  HeartPulse,
  Infinity as InfinityIcon,
  MessageSquareWarning,
  MessageSquareText,
  PackageOpen,
  RefreshCw,
  Settings,
  WandSparkles,
  Wrench,
  type LucideIcon,
} from 'lucide-react'

export type PageId =
  | 'overview'
  | 'chat'
  | 'sessions'
  | 'canvas'
  | 'mcp'
  | 'skills'
  | 'plugins'
  | 'backups'
  | 'health'
  | 'maintenance'
  | 'feedback'
  | 'updates'
  | 'settings'
  | 'tutorial'

export interface NavigationItem {
  id: PageId
  label: string
  icon: LucideIcon
  group: NavigationGroup
  /** One-line explanation for hover, page lead, and empty states. */
  hint?: string
  /** Marks a destination that exists in the IA but has no shipped feature yet. */
  placeholder?: boolean
}

// Task-oriented grouping (nav IA scheme A, #67/#69): 'use' is the daily-driver
// destinations, 'extensions' is the mid-frequency MCP/Skills/market trio, and
// 'more' is the lower-frequency system-management group, collapsed by default.
export type NavigationGroup = 'use' | 'extensions' | 'more'

export const navigationItems: readonly NavigationItem[] = [
  { id: 'overview', label: '首页', icon: Gauge, group: 'use', hint: '安装和打开 AI 编程工具' },
  { id: 'chat', label: '聊天', icon: Bot, group: 'use', hint: '在软件里直接问 AI' },
  { id: 'sessions', label: '记录', icon: MessageSquareText, group: 'use', hint: '查看以前的对话' },
  {
    id: 'canvas',
    label: '画布',
    icon: InfinityIcon,
    group: 'use',
    // Not a page switch: clicking this opens a separate, isolated window
    // (see App.tsx's onNavigate override) rather than rendering inline, so
    // it is intentionally excluded from the activePage ternary chain.
    hint: '用节点拼工作流，单独窗口打开',
  },
  {
    id: 'mcp',
    label: '外接工具',
    icon: Blocks,
    group: 'extensions',
    hint: '让 AI 连接数据库、浏览器等',
  },
  {
    id: 'skills',
    label: '技能',
    icon: WandSparkles,
    group: 'extensions',
    hint: '给 AI 加上常用能力',
  },
  {
    id: 'plugins',
    label: '插件',
    icon: PackageOpen,
    group: 'extensions',
    hint: '给命令行工具加功能',
  },
  { id: 'backups', label: '备份', icon: ArchiveRestore, group: 'more', hint: '保存和恢复本机配置' },
  { id: 'health', label: '检查', icon: HeartPulse, group: 'more', hint: '看本机环境正不正常' },
  { id: 'maintenance', label: '安装卸载', icon: Wrench, group: 'more', hint: '安装、卸载或升级工具' },
  { id: 'feedback', label: '反馈', icon: MessageSquareWarning, group: 'more', hint: '出问题发给我们' },
  { id: 'tutorial', label: '教程', icon: BookOpen, group: 'more', hint: '一步步教你怎么用' },
  { id: 'updates', label: '更新', icon: RefreshCw, group: 'more', hint: '升级本软件' },
  { id: 'settings', label: '设置', icon: Settings, group: 'more', hint: '改主题、工作目录和启动项' },
]

export function navigationItem(pageId: PageId): NavigationItem {
  return navigationItems.find((item) => item.id === pageId) ?? navigationItems[0]
}

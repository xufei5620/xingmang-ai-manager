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
  /** One-line hover explanation shown next to the label (expanded sidebar only). */
  hint?: string
  /** Marks a destination that exists in the IA but has no shipped feature yet. */
  placeholder?: boolean
}

// Task-oriented grouping (nav IA scheme A, #67/#69): 'use' is the daily-driver
// destinations, 'extensions' is the mid-frequency MCP/Skills/market trio, and
// 'more' is the lower-frequency system-management group, collapsed by default.
export type NavigationGroup = 'use' | 'extensions' | 'more'

export const navigationItems: readonly NavigationItem[] = [
  { id: 'overview', label: '工具概览', icon: Gauge, group: 'use' },
  { id: 'chat', label: 'AI聊天', icon: Bot, group: 'use' },
  { id: 'sessions', label: '会话管理', icon: MessageSquareText, group: 'use' },
  {
    id: 'canvas',
    label: '无限画布',
    icon: InfinityIcon,
    group: 'use',
    // Not a page switch: clicking this opens a separate, isolated window
    // (see App.tsx's onNavigate override) rather than rendering inline, so
    // it is intentionally excluded from the activePage ternary chain.
    hint: '可视化组织你的 AI 创作流程，独立窗口打开',
  },
  {
    id: 'mcp',
    label: 'MCP 管理',
    icon: Blocks,
    group: 'extensions',
    hint: '让 AI 连接外部工具和数据（数据库、浏览器等），扩展它能干的事',
  },
  {
    id: 'skills',
    label: 'Skills 管理',
    icon: WandSparkles,
    group: 'extensions',
    hint: '可复用的技能包，把常用流程固化，让 AI 一步到位',
  },
  {
    id: 'plugins',
    label: '插件市场',
    icon: PackageOpen,
    group: 'extensions',
    hint: '社区做好的扩展，一键安装给 CLI 加功能',
  },
  { id: 'backups', label: '配置备份', icon: ArchiveRestore, group: 'more' },
  { id: 'health', label: '健康诊断', icon: HeartPulse, group: 'more' },
  { id: 'maintenance', label: '安装维护', icon: Wrench, group: 'more' },
  { id: 'feedback', label: '反馈与诊断', icon: MessageSquareWarning, group: 'more' },
  { id: 'tutorial', label: '教程文档', icon: BookOpen, group: 'more' },
  { id: 'updates', label: '检查更新', icon: RefreshCw, group: 'more' },
  { id: 'settings', label: '设置', icon: Settings, group: 'more' },
]

export function navigationItem(pageId: PageId): NavigationItem {
  return navigationItems.find((item) => item.id === pageId) ?? navigationItems[0]
}

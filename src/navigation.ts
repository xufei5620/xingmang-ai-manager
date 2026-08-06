import {
  ArchiveRestore,
  Blocks,
  Gauge,
  HeartPulse,
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
  | 'sessions'
  | 'mcp'
  | 'skills'
  | 'plugins'
  | 'backups'
  | 'health'
  | 'maintenance'
  | 'feedback'
  | 'updates'
  | 'settings'

export interface NavigationItem {
  id: PageId
  label: string
  icon: LucideIcon
}

export const navigationItems: readonly NavigationItem[] = [
  { id: 'overview', label: '工具概览', icon: Gauge },
  { id: 'sessions', label: '会话管理', icon: MessageSquareText },
  { id: 'mcp', label: 'MCP 管理', icon: Blocks },
  { id: 'skills', label: 'Skills 管理', icon: WandSparkles },
  { id: 'plugins', label: 'Plugins/市场', icon: PackageOpen },
  { id: 'backups', label: '配置备份', icon: ArchiveRestore },
  { id: 'health', label: '健康诊断', icon: HeartPulse },
  { id: 'maintenance', label: '安装维护', icon: Wrench },
  { id: 'feedback', label: '反馈与诊断', icon: MessageSquareWarning },
  { id: 'updates', label: '检查更新', icon: RefreshCw },
  { id: 'settings', label: '设置', icon: Settings },
]

export function navigationItem(pageId: PageId): NavigationItem {
  return navigationItems.find((item) => item.id === pageId) ?? navigationItems[0]
}

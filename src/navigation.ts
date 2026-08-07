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
  group: NavigationGroup
}

export type NavigationGroup = 'workbench' | 'extensions' | 'system' | 'utility'

export const navigationItems: readonly NavigationItem[] = [
  { id: 'overview', label: '工具概览', icon: Gauge, group: 'workbench' },
  { id: 'sessions', label: '会话管理', icon: MessageSquareText, group: 'workbench' },
  { id: 'mcp', label: 'MCP 管理', icon: Blocks, group: 'extensions' },
  { id: 'skills', label: 'Skills 管理', icon: WandSparkles, group: 'extensions' },
  { id: 'plugins', label: 'Plugins/市场', icon: PackageOpen, group: 'extensions' },
  { id: 'backups', label: '配置备份', icon: ArchiveRestore, group: 'system' },
  { id: 'health', label: '健康诊断', icon: HeartPulse, group: 'system' },
  { id: 'maintenance', label: '安装维护', icon: Wrench, group: 'system' },
  { id: 'feedback', label: '反馈与诊断', icon: MessageSquareWarning, group: 'utility' },
  { id: 'updates', label: '检查更新', icon: RefreshCw, group: 'utility' },
  { id: 'settings', label: '设置', icon: Settings, group: 'utility' },
]

export function navigationItem(pageId: PageId): NavigationItem {
  return navigationItems.find((item) => item.id === pageId) ?? navigationItems[0]
}

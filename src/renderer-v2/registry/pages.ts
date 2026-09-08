import { Archive, BookOpen, Clock, Flag, Home, Infinity as InfinityIcon, MessageSquare, Package, Plug, RefreshCw, Settings, Sparkles, User, Wrench, Zap, type LucideIcon } from 'lucide-react'

export const pages = [
  { id: 'home', label: '首页', icon: 'home', group: 'daily', template: 'T5', testId: 'page-home' },
  { id: 'chat', label: '聊天', icon: 'message-square', group: 'daily', template: '专用', testId: 'page-chat' },
  { id: 'sessions', label: '记录', icon: 'clock', group: 'daily', template: 'T3', testId: 'page-sessions' },
  { id: 'canvas', label: '画布 ↗', icon: 'infinity', group: 'daily', template: '独立窗口', testId: 'nav-canvas' },
  { id: 'mcp', label: '外接工具', icon: 'plug', group: 'extend', template: 'T1', testId: 'page-mcp' },
  { id: 'skills', label: '技能', icon: 'sparkles', group: 'extend', template: 'T1', testId: 'page-skills' },
  { id: 'plugins', label: '插件', icon: 'package', group: 'extend', template: 'T1', testId: 'page-plugins' },
  { id: 'tutorial', label: '教程', icon: 'book-open', group: 'maintain', template: '专用', testId: 'page-tutorial' },
  { id: 'health', label: '检查', icon: 'zap', group: 'maintain', template: '专用', testId: 'page-health' },
  { id: 'maintenance', label: '安装卸载', icon: 'wrench', group: 'maintain', template: '专用', testId: 'page-maintenance' },
  { id: 'backups', label: '备份', icon: 'archive', group: 'maintain', template: 'T1', testId: 'page-backups' },
  { id: 'feedback', label: '反馈', icon: 'flag', group: 'maintain', template: 'T1', testId: 'page-feedback' },
  { id: 'updates', label: '更新', icon: 'refresh-cw', group: 'maintain', template: '专用', testId: 'page-updates' },
  { id: 'settings', label: '设置', icon: 'settings', group: 'maintain', template: 'T2', testId: 'page-settings' },
  { id: 'account', label: '个人中心', icon: 'user', group: 'account', template: 'T2', testId: 'page-account' },
] as const;
export type PageId = typeof pages[number]['id'];
export type PageGroup = 'daily' | 'extend' | 'maintain' | 'account'
export interface PageDefinition { id: PageId; label: string; icon: LucideIcon; group: PageGroup; testId: string; external?: boolean }
const pageIcons: Record<PageId, LucideIcon> = { home: Home, chat: MessageSquare, sessions: Clock, canvas: InfinityIcon, mcp: Plug, skills: Sparkles, plugins: Package, tutorial: BookOpen, health: Zap, maintenance: Wrench, backups: Archive, feedback: Flag, updates: RefreshCw, settings: Settings, account: User }
export const pageRegistry: readonly PageDefinition[] = pages.map((page) => ({ id: page.id, label: page.label.replace(' ↗', ''), icon: pageIcons[page.id], group: page.group as PageGroup, testId: page.testId, external: page.id === 'canvas' }))

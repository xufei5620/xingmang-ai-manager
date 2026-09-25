import { Archive, BookOpen, Clock, Flag, Globe2, Home, Infinity as InfinityIcon, MessageSquare, Package, Plug, RefreshCw, Settings, Sparkles, User, Wrench, Zap, type LucideIcon } from 'lucide-react'

export const pages = [
  { id: 'home', label: '首页', icon: 'home', group: 'daily', template: 'T5', testId: 'page-home' },
  { id: 'chat', label: '聊天', icon: 'message-square', group: 'daily', template: '专用', testId: 'page-chat' },
  { id: 'sessions', label: '记录', icon: 'clock', group: 'daily', template: 'T3', testId: 'page-sessions' },
  { id: 'canvas', label: '画布 ↗', icon: 'infinity', group: 'daily', template: '独立窗口', testId: 'nav-canvas' },
  { id: 'acceleration', label: '游戏加速', icon: 'globe-2', group: 'daily', template: 'T5', testId: 'page-acceleration' },
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
const pageIcons: Record<PageId, LucideIcon> = { home: Home, chat: MessageSquare, sessions: Clock, canvas: InfinityIcon, acceleration: Globe2, mcp: Plug, skills: Sparkles, plugins: Package, tutorial: BookOpen, health: Zap, maintenance: Wrench, backups: Archive, feedback: Flag, updates: RefreshCw, settings: Settings, account: User }
export const pageRegistry: readonly PageDefinition[] = pages.map((page) => ({ id: page.id, label: page.label.replace(' ↗', ''), icon: pageIcons[page.id], group: page.group as PageGroup, testId: page.testId, external: page.id === 'canvas' }))
/** 顶部搜索用的常用说法，界面上不显示；Record 漏页是编译错。 */
export const pageSearchKeywords: Record<PageId, readonly string[]> = {
  home: ['主页', '我的工具', '打开工具'],
  chat: ['对话', '问答', '提问', '生图', '画图'],
  sessions: ['历史', '会话', '聊天记录', '接着聊'],
  canvas: ['画图', '生图', '工作流'],
  acceleration: ['加速', '游戏', '延迟', '卡顿'],
  mcp: ['MCP', '外部工具'],
  skills: ['Skill'],
  plugins: ['Plugin', '扩展'],
  tutorial: ['帮助', '怎么用', '说明', '新手'],
  health: ['检测', '诊断', '体检', '环境'],
  maintenance: ['装', '安装', '装不上', '删', '卸载', '重装', '下载'],
  backups: ['恢复', '还原', '找回配置'],
  feedback: ['客服', '报告', '日志', '投诉'],
  updates: ['升级', '新版本', '版本'],
  settings: ['选项', '偏好'],
  account: ['账号', '我的', '个人信息'],
};

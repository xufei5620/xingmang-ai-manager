import { Archive, BookOpen, Clock, Flag, Globe2, Home, Infinity as InfinityIcon, MessageSquare, Package, Plug, RefreshCw, Settings, Sparkles, Star, User, Wrench, Zap, type LucideIcon } from 'lucide-react'

export const pages = [
  { id: 'home', label: '首页', icon: 'home', group: 'daily', template: 'T5', testId: 'page-home' },
  { id: 'chat', label: '聊天', icon: 'message-square', group: 'daily', template: '专用', testId: 'page-chat' },
  { id: 'sessions', label: '记录', icon: 'clock', group: 'daily', template: 'T3', testId: 'page-sessions' },
  { id: 'canvas', label: '画布', icon: 'infinity', group: 'daily', template: '独立窗口', testId: 'nav-canvas' },
  { id: 'acceleration', label: '游戏加速', icon: 'globe-2', group: 'daily', template: 'T5', testId: 'page-acceleration' },
  { id: 'featured', label: '精选', icon: 'star', group: 'extend', template: 'T1', testId: 'page-featured' },
  { id: 'mcp', label: '外接工具', icon: 'plug', group: 'extend', template: 'T1', testId: 'page-mcp' },
  { id: 'skills', label: '技能', icon: 'sparkles', group: 'extend', template: 'T1', testId: 'page-skills' },
  { id: 'plugins', label: '插件', icon: 'package', group: 'extend', template: 'T1', testId: 'page-plugins' },
  { id: 'tutorial', label: '教程', icon: 'book-open', group: 'maintain', template: '专用', testId: 'page-tutorial' },
  { id: 'health', label: '检查', icon: 'zap', group: 'maintain', template: '专用', testId: 'page-health' },
  { id: 'maintenance', label: '安装卸载', icon: 'wrench', group: 'maintain', template: '专用', testId: 'page-maintenance' },
  { id: 'backups', label: '备份', icon: 'archive', group: 'maintain', template: 'T1', testId: 'page-backups' },
  { id: 'feedback', label: '反馈与客服', icon: 'flag', group: 'maintain', template: 'T1', testId: 'page-feedback' },
  { id: 'updates', label: '更新', icon: 'refresh-cw', group: 'maintain', template: '专用', testId: 'page-updates' },
  { id: 'settings', label: '设置', icon: 'settings', group: 'maintain', template: 'T2', testId: 'page-settings' },
  { id: 'account', label: '个人中心', icon: 'user', group: 'account', template: 'T2', testId: 'page-account' },
] as const;
export type PageId = typeof pages[number]['id'];
export type PageGroup = 'daily' | 'extend' | 'maintain' | 'account'
export interface PageDefinition { id: PageId; label: string; icon: LucideIcon; group: PageGroup; testId: string; external?: boolean }
const pageIcons: Record<PageId, LucideIcon> = { home: Home, chat: MessageSquare, sessions: Clock, canvas: InfinityIcon, acceleration: Globe2, featured: Star, mcp: Plug, skills: Sparkles, plugins: Package, tutorial: BookOpen, health: Zap, maintenance: Wrench, backups: Archive, feedback: Flag, updates: RefreshCw, settings: Settings, account: User }
export const pageRegistry: readonly PageDefinition[] = pages.map((page) => ({ id: page.id, label: page.label, icon: pageIcons[page.id], group: page.group as PageGroup, testId: page.testId, external: page.id === 'canvas' }))
/**
 * v4 起游戏加速、备份、更新三页并进设置（第 9 批），页面 id 留作别名：托盘、系统通知、
 * 旧测试和各处「去备份」按钮照样能跳，落到设置里对应那一张卡（值是设置行的 id）。
 */
export const settingsPageAliases = { acceleration: 'acceleration', backups: 'backups', updates: 'version' } as const;
export type SettingsPageAlias = keyof typeof settingsPageAliases
export function settingsPageAlias(page: PageId): typeof settingsPageAliases[SettingsPageAlias] | null {
  return page === 'acceleration' || page === 'backups' || page === 'updates' ? settingsPageAliases[page] : null
}
/**
 * v4 起「安装卸载」页拆掉（第 10 批）：工具的安装、重新安装、卸载都在首页卡片上，Node.js、Python、Git
 * 的安装挪进检查页那几行，安装过程的记录在「反馈与客服」的运行日志里。页面 id 留作别名：教程、旧测试
 * 和别处还叫它的跳转落到首页。
 */
export const retiredPageAliases = { maintenance: 'home' } as const;
export type RetiredPageAlias = keyof typeof retiredPageAliases
export function retiredPageAlias(page: PageId): typeof retiredPageAliases[RetiredPageAlias] | null {
  return page === 'maintenance' ? retiredPageAliases[page] : null
}
/** 顶部搜索用的常用说法，界面上不显示；Record 漏页是编译错。别名页不单独出结果，说法挪进了它们的新去处。 */
export const pageSearchKeywords: Record<Exclude<PageId, SettingsPageAlias | RetiredPageAlias>, readonly string[]> = {
  // v4 起工具的安装、更新、回到推荐版本、重新安装、卸载都在首页卡片上；余额卡上有还能用几天。
  home: ['主页', '我的工具', '打开工具', '配置', '换模型', '工具卡片', '接着上次', '还能用几天', '更新工具', '回到推荐版本', '退回版本', '重新安装', '卸载工具', '装', '安装', '删', '卸载', '重装', '下载'],
  chat: ['对话', '问答', '提问', '生图', '画图', '分组', '模型'],
  sessions: ['历史', '会话', '聊天记录', '接着聊'],
  canvas: ['画图', '生图', '工作流'],
  featured: ['推荐', '好用的', '扩展推荐', '星芒精选'],
  // 入口改了名、页签合了页，旧说法照样搜得到。
  mcp: ['MCP', '外部工具', '自定义连接', '添加连接', '连接'],
  skills: ['Skill', '从文件夹导入', '导入技能'],
  plugins: ['Plugin', '扩展', '市场', '插件市场', '官方市场'],
  tutorial: ['帮助', '怎么用', '说明', '新手'],
  // 「安装卸载」页拆掉以后，Node.js、Python、Git 在这一页装（第 10 批）。
  health: ['检测', '诊断', '体检', '环境', '运行环境', 'Node.js', 'Python', 'Git', '装不上', '代理', '证书', '测试连接'],
  feedback: ['客服', '报告', '日志', '运行日志', '安装记录', '投诉', '留言', '建议', '二维码', '微信'],
  settings: ['选项', '偏好'],
  account: ['账号', '我的', '个人信息'],
};

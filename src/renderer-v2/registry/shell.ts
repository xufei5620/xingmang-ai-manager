import type { PageId } from './pages'

/** 侧栏的一项：一页，或「充值」（个人中心的充值页签，在侧栏单独占一行）。 */
export type ShellNavigationEntry = PageId | 'recharge'
export interface ShellNavigationGroup {
  /** 分组小标题；缺省 = 只用一条分隔线隔开。 */
  label?: string
  entries: readonly ShellNavigationEntry[]
}
export const shellNavigation: readonly ShellNavigationGroup[] = [
  { entries: ['home', 'chat', 'sessions', 'canvas'] },
  { label: '扩展', entries: ['featured', 'mcp', 'skills', 'plugins'] },
  { entries: ['recharge', 'tutorial', 'health', 'feedback'] },
]
/** 界面导览三步：没有标题，第一步按系统只写一种快捷键。 */
export const shellTour = [
  { target: '.v2-command-trigger', body: { win: '按 Ctrl K 随时搜索页面、设置和操作，比翻菜单快。', mac: '按 ⌘ K 随时搜索页面、设置和操作，比翻菜单快。' } },
  // 第二步指着首页第一张工具卡片（v4 批 04）；导览开在别的页上、卡片不在时退回侧栏「首页」。
  { target: ['[data-testid="tool-row-claude"]', '[data-testid="nav-home"]'], placement: 'right', body: '每个工具一张卡片。点左下角的账号标签，可以在当前账号和官方账号之间切换。' },
  { target: '[data-testid="account-entry"]', placement: 'right', body: '余额和订阅在这里，点它进入个人中心，充值、看用量都在里面。' },
] as const

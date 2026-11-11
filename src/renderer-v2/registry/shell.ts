import type { PageId } from './pages'

/** 侧栏的一项：一页，或「充值」（个人中心的充值页签，在侧栏单独占一行，钉在「设置」上面，见 Shell.tsx）。 */
export type ShellNavigationEntry = PageId | 'recharge'
export interface ShellNavigationGroup {
  /** 分组小标题；缺省 = 只用一条分隔线隔开。 */
  label?: string
  entries: readonly ShellNavigationEntry[]
}
// 这里是会跟着滚的那一列；「充值」「设置」不在里面，钉在它下面、账号卡上面（Shell.tsx）。
// 2026-11-06 加了画布、视频剪辑以后这列长了两行，窗口矮时最下面一组最先滚出去，
// 「充值」原来排在那组第一个，跟着看不见（yoyo 回「充值改」）。
export const shellNavigation: readonly ShellNavigationGroup[] = [
  { entries: ['home', 'chat', 'sessions', 'canvas', 'video'] },
  { label: '扩展', entries: ['featured', 'mcp', 'skills', 'plugins'] },
  { entries: ['tutorial', 'health', 'feedback'] },
]
/** 界面导览三步：没有标题，第一步按系统只写一种快捷键。 */
export const shellTour = [
  { target: '.v2-command-trigger', body: { win: '按 Ctrl K 随时搜索页面、设置和操作，比翻菜单快。', mac: '按 ⌘ K 随时搜索页面、设置和操作，比翻菜单快。' } },
  // 第二步指着首页第一张工具卡片（v4 批 04）。导览只在首页放（Shell.tsx）；卡片还没画出来或被滚出去时退回侧栏「首页」。
  { target: ['[data-testid="tool-row-claude"]', '[data-testid="nav-home"]'], placement: 'right', body: '每个工具一张卡片。点左下角的账号标签，可以在当前账号和官方账号之间切换。' },
  { target: '[data-testid="account-entry"]', placement: 'right', body: '余额和订阅在这里，点它进入个人中心，充值、看用量都在里面。' },
] as const

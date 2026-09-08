import type { PageId } from './pages'

export const shellNavigation: ReadonlyArray<readonly PageId[]> = [
  ['home', 'chat', 'sessions', 'canvas'],
  ['mcp', 'skills', 'plugins'],
  ['tutorial', 'health'],
]
export const moreNavigation: readonly PageId[] = ['maintenance', 'backups', 'feedback', 'updates']
export const shellTour = [
  { target: '.v2-command-trigger', title: '随时找到要用的功能', body: '按 Ctrl / ⌘ K 打开搜索，也可以从左侧导航进入。' },
  { target: '[data-testid="nav-home"]', title: '工具都在首页', body: '查看安装和连接状态，从工具旁边打开配置或开始工作。' },
  { target: '[data-testid="account-entry"]', title: '余额与账号在这里', body: '打开个人中心查看用量、密钥和订单，也可以切换账号。' },
] as const

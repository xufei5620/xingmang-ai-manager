export const accountTabs = [
  { value: 'overview', label: '我的账号' },
  { value: 'dashboard', label: '用量看板' },
  { value: 'keys', label: '密钥' },
  { value: 'usage', label: '调用明细' },
  { value: 'tasks', label: '异步任务' },
  { value: 'recharge', label: '充值与订阅' },
  { value: 'orders', label: '我的订单' },
  { value: 'invite', label: '邀请返利' },
  { value: 'devices', label: '登录设备' },
] as const
export const settingsGroups = [
  { value: 'appearance', label: '外观' },
  { value: 'startup', label: '启动与关闭' },
  { value: 'tools', label: '工具' },
  { value: 'network', label: '网络' },
  { value: 'notifications', label: '通知' },
  { value: 'account', label: '账号' },
  { value: 'privacy', label: '隐私与数据' },
  { value: 'about', label: '关于' },
] as const
export const scopeOptions = [
  { value: 'all', label: '全部范围' },
  { value: 'user', label: '我的（全局）' },
  { value: 'project', label: '当前项目' },
  { value: 'workspace', label: '当前工作区' },
  { value: 'builtin', label: '系统内置' },
]
export const updateLabels = {
  disabled: '当前环境暂不提供自动更新',
  idle: '检查有没有新版本',
  checking: '正在检查新版本…',
  available: '发现新版本',
  'not-available': '已是最新版本',
  downloading: '正在下载更新…',
  downloaded: '更新已下载',
  cancelled: '下载已取消',
  error: '更新没有完成',
} as const
export const keyStates = {
  1: { label: '有效', tone: 'ok' },
  2: { label: '已停用', tone: 'neutral' },
  3: { label: '已过期', tone: 'warn' },
  4: { label: '额度用完', tone: 'warn' },
} as const
export const orderStates = {
  pending: { label: '等待支付', tone: 'warn' },
  success: { label: '已到账', tone: 'ok' },
  failed: { label: '支付失败', tone: 'bad' },
  expired: { label: '已超时', tone: 'neutral' },
  unknown: { label: '待确认', tone: 'neutral' },
} as const
export const billingOptions = [
  { value: 'subscription_first', label: '优先用订阅' },
  { value: 'wallet_first', label: '优先用余额' },
  { value: 'subscription_only', label: '只用订阅' },
  { value: 'wallet_only', label: '只用余额' },
]
export const mcpQuickLinks = [
  {
    name: '浏览器',
    id: 'browser',
    command: 'npx',
    args: '["-y", "@playwright/mcp@latest"]',
  },
  { name: 'GitHub', id: 'github', url: 'https://api.githubcopilot.com/mcp/' },
  {
    name: '本地文件',
    id: 'files',
    command: 'npx',
    args: '["-y", "@modelcontextprotocol/server-filesystem"]',
  },
]
export const taskStates: Record<
  string,
  { label: string; tone: 'neutral' | 'accent' | 'ok' | 'bad' }
> = {
  NOT_START: { label: '尚未开始', tone: 'neutral' },
  SUBMITTED: { label: '已提交', tone: 'neutral' },
  QUEUED: { label: '排队中', tone: 'neutral' },
  IN_PROGRESS: { label: '处理中', tone: 'accent' },
  SUCCESS: { label: '已完成', tone: 'ok' },
  FAILURE: { label: '失败', tone: 'bad' },
  UNKNOWN: { label: '待确认', tone: 'neutral' },
}
export const usageFilterFields = [
  { key: 'start', label: '开始时间', type: 'datetime-local' as const },
  { key: 'end', label: '结束时间', type: 'datetime-local' as const },
  { key: 'modelName', label: '模型名称' },
  { key: 'group', label: '分组' },
  {
    key: 'type',
    label: '日志类型',
    options: [
      { value: '', label: '全部类型' },
      ...['其他', '充值', '消费', '管理', '系统', '错误', '退款', '登录'].map(
        (label, value) => ({ value: String(value), label }),
      ),
    ],
  },
  { key: 'tokenName', label: '令牌名称' },
  { key: 'requestId', label: '请求 ID' },
  { key: 'upstreamRequestId', label: '上游请求 ID' },
]
export const taskFilterFields = [
  { key: 'start', label: '开始时间', type: 'datetime-local' as const },
  { key: 'end', label: '结束时间', type: 'datetime-local' as const },
  { key: 'platform', label: '平台' },
  { key: 'taskId', label: '任务 ID' },
  {
    key: 'status',
    label: '状态',
    options: [
      { value: '', label: '全部状态' },
      ...Object.entries(taskStates).map(([value, { label }]) => ({
        value,
        label,
      })),
    ],
  },
  { key: 'action', label: '动作' },
]
export const skinOptions = [
  { value: 'dawn', label: '晨曦金', bright: '#E6BF7A', dark: '#0B1F3B' },
  { value: 'obsidian', label: '极夜黑金', bright: '#EDD39B', dark: '#101114' },
  { value: 'mist', label: '雾青', bright: '#7BDDD0', dark: '#0C1A1E' },
  { value: 'aurora', label: '极光紫', bright: '#C0B6FB', dark: '#120F22' },
] as const
export const notificationOptions = [
  {
    value: 'install',
    label: '安装 / 更新完成',
    description: '工具准备完成后提醒你查看结果',
  },
  {
    value: 'balance',
    label: '余额不足',
    description: '星芒美元余额低于 $5 时提醒',
  },
  {
    value: 'task',
    label: '异步任务完成',
    description: '已关注的任务完成后提醒你查看结果',
  },
] as const

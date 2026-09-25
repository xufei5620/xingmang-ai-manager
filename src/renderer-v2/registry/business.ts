import type { UpdateFailedStep, UpdateSnapshot } from '../../../electron/ipc-contract'
/**
 * 教程里讲「Mac 上怎么自己装桌面端」的那一章。首页那几行点不动的「安装」要直接跳到
 * 这一章而不是教程首页，所以 id 放在注册表里由两边共用：教程页写章节、App 写跳转，
 * 谁改了名字另一边编译不会报错，只会静悄悄跳回第一章，因此不许再写成字面量。
 */
export const macDesktopTutorialTopic = 'mac-desktop-apps'
/** 同理：教程里讲「Mac 上怎么自己装 Node.js 和 Python」的那一章。 */
export const macRuntimeTutorialTopic = 'runtime-mac'
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
/**
 * 更新失败分三步说。只报一句「更新没有完成」时，断网点一次「检查更新」也会被
 * 告知更新装不上、按钮还写着「重新下载」——更新其实根本没开始下。标题和按钮都
 * 只在这里定义一次，首页气泡和更新页读同一份。
 */
export const updateFailureLabels = {
  check: { title: '检查更新失败', retry: '重试' },
  download: { title: '下载更新失败', retry: '重新下载' },
  install: { title: '安装更新失败', retry: '重新安装' },
} as const
// 旧版本的快照没有 failedStep。说不清是哪一步，就别编一个步骤名出来。
export const updateFailureFallback = { title: '更新没有完成', retry: '重新下载' } as const
export function updateFailureLabel(step: UpdateFailedStep | null | undefined) {
  return step ? updateFailureLabels[step] : updateFailureFallback
}
/**
 * 发布者撤回了本机这个版本（状态文件的 badVersions），或者找到的「新版本」其实比
 * 本机旧（退回上一个好版本）时，照常说「发现新版本」就是在骗人。这几句也只在这里
 * 定义一次，更新页与首页气泡读同一份。
 */
type UpdateOfferState = Pick<UpdateSnapshot, 'phase' | 'currentVersion' | 'availableVersion' | 'rollback' | 'currentVersionWithdrawn'>
export function updateCardTitle(update: UpdateOfferState): string {
  if (update.rollback && update.phase === 'available') return '建议退回稳定版本'
  if (update.currentVersionWithdrawn && (update.phase === 'not-available' || update.phase === 'idle')) return '这个版本有已知问题'
  return updateLabels[update.phase]
}
export function updateBubbleTitle(update: UpdateOfferState): string {
  if (update.phase === 'downloaded') return '更新已下载'
  if (update.phase === 'downloading') return '正在下载更新'
  if (update.phase === 'available') return update.rollback ? `建议退回 ${update.availableVersion}` : `新版本 ${update.availableVersion} 可以安装`
  return '这个版本有已知问题'
}
// 提示气泡的正文。自动更新开着时直接告诉用户接下来会怎样，不用他再点进更新页。
export function autoUpdateBubbleBody(phase: UpdateOfferState['phase'], autoUpdate: boolean): string {
  if (!autoUpdate) return '查看更新内容和安装状态。';
  if (phase === 'downloaded') return '已经下好了，关掉软件或下次打开时自动装上，不打断你现在用。';
  return '正在后台下载，下好后关掉软件或下次打开时自动装上。';
}
export function withdrawnVersionAdvice(update: UpdateOfferState): string {
  const next = update.availableVersion
  if (next && update.rollback) return `发布者撤回了 ${update.currentVersion}。建议装回 ${next}：先下载，再点「重启安装」。`
  if (next) return `发布者撤回了 ${update.currentVersion}，修好的 ${next} 已经可以装了，建议尽快更新。`
  return `发布者撤回了 ${update.currentVersion}。修好的版本准备好后，这里会提示你更新。`
}
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
    label: '安装 / 更新结果',
    description: '工具装好或没装上时提醒你',
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
  {
    value: 'cliUpdate',
    label: '工具有新版本',
    description: '你装的命令行工具出新版本时提醒一次',
  },
  {
    value: 'announcement',
    label: '新公告',
    description: '软件在后台时有新公告，提醒一次',
  },
  {
    value: 'acceleration',
    label: '加速提醒',
    description: '免费加速还剩 5 分钟、用完自动断开、加速意外断开，以及软件替你自动连上加速时各提醒一次',
  },
] as const

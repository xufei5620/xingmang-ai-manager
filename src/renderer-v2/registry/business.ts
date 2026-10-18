import { Archive, Bell, Globe, Play, RefreshCw, Shield, Sun, Terminal, type LucideIcon } from 'lucide-react'
import type { UpdateFailedStep, UpdateSnapshot } from '../../../electron/ipc-contract'
import type { PlatformNotificationKind } from '../../../electron/platform/contract'
import { describeUpdateDiskShortfall } from '../../../electron/disk-space-copy'
import { connectionRouteSettings } from './connection-routes'
/**
 * 教程里讲「Mac 上怎么自己装桌面端」的那一章。首页那几行点不动的「安装」要直接跳到
 * 这一章而不是教程首页，所以 id 放在注册表里由两边共用：教程页写章节、App 写跳转，
 * 谁改了名字另一边编译不会报错，只会静悄悄跳回第一章，因此不许再写成字面量。
 */
export const macDesktopTutorialTopic = 'mac-desktop-apps'
/** 同理：教程里讲「Mac 上怎么自己装 Node.js 和 Python」的那一章。 */
export const macRuntimeTutorialTopic = 'runtime-mac'
/**
 * 同理：「Codex 桌面端怎么安装？」那一章；安装卸载页桌面端那一行（不在 Mac 上时）的
 * 「查看安装步骤」跳到这里。教程那边还写着字面量，pages-maintenance.test.ts 钉着两边一致。
 */
export const desktopInstallTutorialTopic = 'install'
/** 同理：「备份、更新与数据」那一章，里面有「磁盘快满了、更新下不下来怎么办」。 */
export const updatesTutorialTopic = 'safety'
/** 同理：「进阶：安装与使用命令行工具」那一章；设置里「用哪个终端打开工具」跳到这里。 */
export const cliTutorialTopic = 'cli'
// keywords 是顶部搜索用的常用说法：小白搜「余额」「Key」「开机」时也要能找到对应的分页，
// 界面上不显示。次序就是个人中心顶上那排页签从左到右的次序。
// v4 把原来的九个分页并成这六个：「我的订单」「异步任务」「登录设备」成了页签里的一节，
// 搜它们的说法挂在下面的 accountSections 上，不再写进页签自己的 keywords，免得同一句搜出两条。
export const accountTabs = [
  { value: 'overview', label: '账号概览', keywords: ['账号', '我的账号', '资料', '头像', '名字', '显示名称', '邮箱', '当前登录'] },
  { value: 'recharge', label: '充值订阅', keywords: ['充值', '余额', '买', '购买', '续费', '付款', '支付', '订阅', '套餐', '兑换', '兑换码', '充值码', '扣费偏好', '扣费顺序', '先扣'] },
  { value: 'usage', label: '用量账单', keywords: ['用量', '统计', '消耗', '花了多少', '账单', '明细', '调用明细', '用量看板', '扣费', '消费', '扣了多少', '花费'] },
  { value: 'keys', label: '密钥管理', keywords: ['密钥', 'Key', 'API Key', '令牌', '秘钥', 'token', '限额', '额度上限'] },
  { value: 'security', label: '账号安全', keywords: ['安全', '密码', '设备'] },
  { value: 'invite', label: '邀请返利', keywords: ['邀请', '返利', '推广', '分享'] },
] as const
export type AccountTabValue = (typeof accountTabs)[number]['value']
/**
 * 个人中心页头「编辑资料」那颗铅笔：顶部搜索搜「编辑资料」「头像」时落到这里，打开编辑资料弹窗。
 */
export const accountProfileAnchor = 'edit-profile'
/**
 * 账号概览「当前登录」那一条里的「切换账号」：顶部搜索搜「切换账号」时，个人中心那一条落到这里。
 */
export const accountSwitchAnchor = 'switch-account'
export const accountSwitchKeywords = ['换账号', '切账号', '换号'] as const
/**
 * 页签里的几处落点。原来单独一个分页的（我的订单、异步任务、登录设备）和挪了地方的（修改密码从
 * 「我的账号」挪到账号安全），顶部搜索、教程、系统通知、付款回跳还按原来的名字跳过来，落到那个
 * 页签的那一节、亮一下。value 同时是页面上那一节的 data-anchor。
 * gated：要看当前账号能不能用（visibleAccountTab 按 value 判断）；不写的哪种账号都有。
 */
export const accountSections = [
  { value: accountSwitchAnchor, tab: 'overview', label: '切换账号', keywords: accountSwitchKeywords },
  { value: accountProfileAnchor, tab: 'overview', label: '编辑资料', keywords: ['改名', '改头像', '换头像', '显示名称'] },
  { value: 'orders', tab: 'recharge', label: '我的订单', keywords: ['订单', '到账', '没到账', '付款记录'], gated: true },
  { value: 'tasks', tab: 'usage', label: '异步任务', keywords: ['任务', '生成进度'], gated: true },
  { value: 'change-password', tab: 'security', label: '修改密码', keywords: ['改密码', '密码'] },
  { value: 'remember-password', tab: 'security', label: '记住密码', keywords: [] },
  { value: 'devices', tab: 'security', label: '登录设备', keywords: ['设备', '下线', '其他电脑', '登录记录'], gated: true },
] as const satisfies ReadonlyArray<{ value: string; tab: AccountTabValue; label: string; keywords: readonly string[]; gated?: boolean }>
export type AccountSectionValue = (typeof accountSections)[number]['value']
/** 外面点名要去的地方：一个页签，或者页签里的一处落点。 */
export type AccountLanding = AccountTabValue | AccountSectionValue
// 只剩旧名字的分页：「用量看板」并进了用量账单最上面，没有单独的落点。
const retiredAccountTabs: Readonly<Record<string, AccountTabValue>> = { dashboard: 'usage' }
/**
 * 外面给的名字（页签、落点或旧分页名）落到哪个页签、要不要翻到哪一节；认不出的回到账号概览。
 * 不在这里看账号能不能用，那由个人中心按 visibleAccountTab 再收一次。
 */
export function resolveAccountLanding(value: string | undefined): { tab: AccountTabValue; anchor?: AccountSectionValue } {
  const tab = accountTabs.find((entry) => entry.value === value)
  if (tab) return { tab: tab.value }
  const section = accountSections.find((entry) => entry.value === value)
  if (section) return { tab: section.tab, anchor: section.value }
  return { tab: (value !== undefined && Object.hasOwn(retiredAccountTabs, value) ? retiredAccountTabs[value] : undefined) ?? 'overview' }
}
/**
 * 「反馈与客服」的两个页签（v4 第 10 批）：留言给客服、看运行日志。navigate('feedback', …) 的第二个参数是
 * 页签，或下面那个落点；不写就停在上回看的那个页签（头一回是「留言反馈」）。
 */
export const feedbackTabs = [
  { value: 'form', label: '留言反馈' },
  { value: 'log', label: '运行日志' },
] as const
export type FeedbackTabValue = (typeof feedbackTabs)[number]['value']
/**
 * 装工具没装上时错误框的「查看日志」：落到运行日志，来源先选好「安装与更新」。「安装卸载」页拆掉以前，
 * 这一下去的是那一页的「安装日志」卡；装的过程本来就逐行记进了运行日志（主进程 source 为 install）。
 */
export const feedbackInstallLogSection = 'install-log'
export function resolveFeedbackLanding(section: string | undefined): { tab: FeedbackTabValue; installLog?: true } | null {
  if (section === feedbackInstallLogSection) return { tab: 'log', installLog: true }
  const tab = feedbackTabs.find((entry) => entry.value === section)
  return tab ? { tab: tab.value } : null
}
// v4 的八组，组名都是四个字（字表批08）。「账号」组拆走了：切换账号、退出登录在账号概览，记住密码在账号安全。
// 备份迁移的 value 不能叫 backups：那是「工具配置备份」那一行的 id，组和行撞名，顶部搜索会把那一行当成一组打开。
export const settingsGroups = [
  { value: 'appearance', label: '外观显示', keywords: ['主题', '深色', '夜间', '颜色', '显卡', '显示', '语言'] },
  { value: 'startup', label: '启动关闭', keywords: ['开机', '自启', '自动启动', '关闭', '托盘', '最小化'] },
  { value: 'tools', label: '工具管理', keywords: ['工作文件夹', '文件夹', '终端', '安装位置', '装在哪'] },
  { value: 'network', label: '网络加速', keywords: ['加速', '游戏', '下载来源', '网络', '证书', '连不上'] },
  { value: 'notifications', label: '消息通知', keywords: ['通知', '提醒', '消息提示'] },
  { value: 'backup', label: '备份迁移', keywords: ['备份', '恢复', '还原', '迁移', '换电脑'] },
  { value: 'privacy', label: '隐私数据', keywords: ['隐私', '数据', '崩溃', '上报', '日志', '统计', '许可'] },
  { value: 'about', label: '版本更新', keywords: ['更新', '升级', '版本', '版本号'] },
] as const
export const settingsGroupIcons: Record<SettingsGroupId, LucideIcon> = { appearance: Sun, startup: Play, tools: Terminal, network: Globe, notifications: Bell, backup: Archive, privacy: Shield, about: RefreshCw }
/**
 * 一组里分段的小标题（外观显示的「文字与缩放」「辅助与显示」……）。行按 settingsItems 的次序排，
 * 挨着的几行 section 相同就画在同一个小标题、同一张卡里；没写 section 的几行画在不带标题的卡里。
 */
export const settingsSections = [
  { value: 'text-scale', group: 'appearance', label: '文字与缩放' },
  { value: 'display', group: 'appearance', label: '辅助与显示' },
  { value: 'routes', group: 'network', label: '连接线路' },
  { value: 'download', group: 'network', label: '下载与连接' },
  { value: 'reminders', group: 'notifications', label: '提醒哪些事' },
  { value: 'transfer', group: 'backup', label: '搬到新电脑' },
] as const satisfies ReadonlyArray<{ value: string; group: SettingsGroupId; label: string }>
export type SettingsSectionId = (typeof settingsSections)[number]['value']
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
 * 只在这里定义一次，首页气泡和版本更新卡读同一份。
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
 * 定义一次，版本更新卡与首页气泡读同一份。
 */
type UpdateOfferState = Pick<UpdateSnapshot, 'phase' | 'currentVersion' | 'availableVersion' | 'rollback' | 'currentVersionWithdrawn' | 'diskShortfall' | 'installMethod'>
export function updateCardTitle(update: UpdateOfferState): string {
  if (update.rollback && update.phase === 'available') return '建议退回稳定版本'
  if (update.currentVersionWithdrawn && (update.phase === 'not-available' || update.phase === 'idle')) return '这个版本有已知问题'
  return updateLabels[update.phase]
}
/** 「有新版本 v{y}」写哪一版。退回旧版本不是新版本，那时不这么写。 */
export function updateNewVersion(update: Pick<UpdateSnapshot, 'currentVersion' | 'availableVersion' | 'rollback'> | null | undefined): string | null {
  if (!update?.availableVersion || update.rollback || update.availableVersion === update.currentVersion) return null
  return update.availableVersion
}
/**
 * 人就在「设置 › 版本更新」时，「正在下载更新」「下载更新失败」「新版本 X 可以安装」这三种气泡说的是
 * 版本卡上写着的同一件事，不弹；离开那一组照旧弹。别的几种（「这个版本有已知问题」等）照旧。
 */
export function updateBubbleRepeatsUpdatesPage(update: UpdateOfferState & Pick<UpdateSnapshot, 'error' | 'failedStep'>): boolean {
  if (update.error) return update.failedStep === 'download'
  if (update.phase === 'downloading') return true
  return update.phase === 'available' && !update.rollback && !update.diskShortfall
}
export function updateBubbleTitle(update: UpdateOfferState): string {
  if (update.phase === 'downloaded') return '更新已下载'
  if (update.phase === 'downloading') return '正在下载更新'
  if (update.phase === 'available' && update.diskShortfall) return '新版本先不下载'
  if (update.phase === 'available') return update.rollback ? `建议退回 ${update.availableVersion}` : `新版本 ${update.availableVersion} 可以安装`
  return '这个版本有已知问题'
}
/**
 * Windows 上账号不在管理员组（update.installNeedsAdminPassword）：下好的新版本不自动装，首页气泡
 * 说整句，版本更新卡拆成标题和正文。主进程 desktop-notifications.ts 的系统通知是同一句，两边字面量
 * 要一致。
 */
export const standardAccountUpdateNotice = {
  title: '这台电脑的账号不是管理员，装更新时要输入管理员密码',
  body: '让有管理员账号的人点一次「重启并安装」，或者找客服。',
} as const;
export const standardAccountUpdateText = `${standardAccountUpdateNotice.title}。${standardAccountUpdateNotice.body}`;
// 提示气泡的正文。自动更新开着时直接告诉用户接下来会怎样，不用他再点进「版本更新」。
// 交给系统安装器的版本（Linux）从不自己装，下好了就请他点一下。
export function autoUpdateBubbleBody(phase: UpdateOfferState['phase'], autoUpdate: boolean, installMethod?: UpdateOfferState['installMethod'], installNeedsAdminPassword?: boolean): string {
  if (installMethod === 'system-installer') {
    if (phase === 'downloaded') return '已经下好了，到「设置 › 版本更新」点「安装新版本」就能装上。';
    return autoUpdate ? '正在后台下载，下好后到「设置 › 版本更新」点「安装新版本」。' : '查看更新内容和安装状态。';
  }
  if (phase === 'downloaded' && installNeedsAdminPassword) return standardAccountUpdateText;
  if (!autoUpdate) return '查看更新内容和安装状态。';
  if (phase === 'downloaded') return '已经下好了，关掉软件或下次打开时自动装上，不打断你现在用。';
  if (installNeedsAdminPassword) return '正在后台下载；这台电脑装更新时要输入管理员密码，下好后不会自动装上。';
  return '正在后台下载，下好后关掉软件或下次打开时自动装上。';
}
/**
 * 磁盘空间不够、这一轮没下更新时的那句。和系统通知读同一份说法（disk-space-copy.ts）；
 * 没有缺口时返回 null，调用方照旧用原来的说法。
 */
export function updateDiskShortfallText(update: Pick<UpdateSnapshot, 'phase' | 'diskShortfall'> | null | undefined, autoUpdate: boolean): string | null {
  if (update?.phase !== 'available' || !update.diskShortfall) return null
  return describeUpdateDiskShortfall(update.diskShortfall, autoUpdate)
}
/** 下载量与速度用的大小：上 GB 与 10 MB 以下写一位小数（整数不带 .0），不到 1 MB 写 KB。*/
export function formatDownloadBytes(bytes: number): string {
  const safe = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  if (safe >= 1024 ** 3) return `${oneDecimal(safe / 1024 ** 3)} GB`;
  const megabytes = safe / 1024 ** 2;
  if (megabytes >= 10) return `${Math.round(megabytes)} MB`;
  if (megabytes >= 1) return `${oneDecimal(megabytes)} MB`;
  if (safe === 0) return '0 KB';
  return `${Math.max(1, Math.round(safe / 1024))} KB`;
}
function oneDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '');
}
/**
 * 还要多久。故意说得粗：一分钟以内按 10 秒取整，一小时以内按分钟往上取，免得数字
 * 每秒都在变；几秒就好的直接说「马上就好」。
 */
export function formatDownloadRemaining(seconds: number): string {
  if (seconds <= 10) return '马上就好';
  if (seconds < 60) return `大约还要 ${Math.min(50, Math.ceil(seconds / 10) * 10)} 秒`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `大约还要 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `大约还要 ${hours} 小时 ${rest} 分钟` : `大约还要 ${hours} 小时`;
}
/**
 * 进度条下面那行：「已下载 38 MB / 共 112 MB · 每秒 1.8 MB · 大约还要 1 分钟」。
 * 速度和剩余时间用主进程算好的近 10 秒平均值；刚开始、或者速度算不出来时只说下了多少，
 * 不知道总大小时连「共多少」也不说。版本卡和强制更新那道门读同一份。
 */
export function updateDownloadDetail(progress: UpdateSnapshot['progress'] | null | undefined): string | null {
  if (!progress) return null;
  const transferred = Math.max(0, progress.transferred || 0);
  const total = Math.max(0, progress.total || 0);
  const parts = [total > 0 ? `已下载 ${formatDownloadBytes(Math.min(transferred, total))} / 共 ${formatDownloadBytes(total)}` : `已下载 ${formatDownloadBytes(transferred)}`];
  const rate = progress.averageBytesPerSecond;
  if (rate && rate > 0 && (total <= 0 || transferred < total)) {
    parts.push(`每秒 ${formatDownloadBytes(rate)}`);
    const remaining = progress.secondsRemaining;
    if (typeof remaining === 'number' && remaining > 0) parts.push(formatDownloadRemaining(remaining));
  }
  return parts.join(' · ');
}
/**
 * 「自动下载更新」那一行的说明（v4 字表批09）。原来版本卡顶上那句页头说明拆掉了，意思挪到这里：
 * 只有普通 Windows 和 Mac 是「关掉星芒时装上」；交给系统安装器的（Linux）下好后要他点安装，
 * 账号不是管理员的 Windows 电脑要输管理员密码，都不能说会自己装上。
 */
export function autoUpdateSettingDescription(installMethod?: UpdateOfferState['installMethod'], installNeedsAdminPassword?: boolean): string {
  if (installMethod === 'system-installer') return '下好后提醒你点安装';
  return installNeedsAdminPassword ? '下好后要输入管理员密码才能装' : '下好后在你关掉星芒时装上';
}
/**
 * 版本卡右上角的小标签：「有新版本 v{y}」「已下载，重启后生效」，其余照旧用 updateCardTitle。
 * 「重启后生效」只对普通 Windows 和 Mac 成立：Linux 要点「安装新版本」，账号不是管理员的 Windows
 * 要输管理员密码，这两种照旧写「更新已下载」，下一步由卡里那条提示和按钮说。
 */
export function updateStatusLabel(update: UpdateOfferState & Pick<UpdateSnapshot, 'installNeedsAdminPassword'>): string {
  const next = update.phase === 'available' && !update.rollback ? updateNewVersion(update) : null
  if (next) return `有新版本 v${next}`
  if (update.phase === 'downloaded' && update.installMethod !== 'system-installer' && !update.installNeedsAdminPassword) return '已下载，重启后生效'
  return updateCardTitle(update)
}
/** 版本卡上「装」那颗按钮。交给系统安装器（Linux）时软件只关掉、不会自己重开，不能叫「重启并安装」。*/
export function updateInstallActionLabel(installMethod: UpdateOfferState['installMethod']): string {
  return installMethod === 'system-installer' ? '安装新版本' : '重启并安装';
}
export const updateInstallNote = '装之前先保存工具里没做完的东西。有工具正在安装时，不会打断它，会先问你或者等下次再装。';
export function withdrawnVersionAdvice(update: UpdateOfferState): string {
  const next = update.availableVersion
  if (next && update.rollback) return `发布者撤回了 ${update.currentVersion}。建议装回 ${next}：先下载，再点「${updateInstallActionLabel(update.installMethod)}」。`
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
/**
 * 订阅卡上的状态。两个账号后台报的都是英文原值：星芒账号有 active / expired / cancelled（后台作废），
 * 历史账号有 active / expired / suspended（暂停）/ revoked（删掉）。这里没有的值界面写「待确认」，
 * 不把英文原样放上去。
 */
export const subscriptionStates: Record<string, { label: string; tone: 'ok' | 'warn' | 'neutral' }> = {
  active: { label: '生效中', tone: 'ok' },
  exhausted: { label: '额度已用完', tone: 'warn' },
  expired: { label: '已到期', tone: 'neutral' },
  cancelled: { label: '已撤销', tone: 'neutral' },
  revoked: { label: '已撤销', tone: 'neutral' },
  suspended: { label: '已停用', tone: 'neutral' },
}
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
  { key: 'tokenName', label: '密钥名称' },
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
export interface NotificationOption {
  value: PlatformNotificationKind
  label: string
  /** 只有两项要说清楚什么时候提醒；其余的标题就说明白了，不另写一句。 */
  description?: string
}
// 次序照 v4：钱的事在前，终端里的事其次，装工具、出新版、任务、公告和加速在后（字表批08）。
// 「做完了」和「在等你回复」还是一个开关：主进程只有一个 cliTurn 偏好。
export const notificationOptions: readonly NotificationOption[] = [
  { value: 'balance', label: '余额不足', description: '余额低于 $5 时提醒' },
  { value: 'spend', label: '花费突然变多', description: '一小时内花费超过平时 5 倍且至少 $5 时提醒' },
  { value: 'cliTurn', label: '终端里的 AI 做完或在等你' },
  { value: 'cliTrouble', label: '终端里没回上' },
  { value: 'install', label: '安装和更新结果' },
  { value: 'cliUpdate', label: '工具有新版本' },
  { value: 'task', label: '后台任务做完' },
  { value: 'announcement', label: '公告与优惠' },
  { value: 'acceleration', label: '加速提醒' },
]
export type SettingsGroupId = (typeof settingsGroups)[number]['value']
/**
 * 设置里不是每台电脑都有的那几行：Mac 的「卸载星芒」能在软件里卸，别的电脑那一行只说怎么卸；
 * 支持自动更新的电脑才有「自动下载更新」；有游戏加速的电脑才有游戏加速卡和「加速提醒」。
 */
export type SettingsItemCondition = 'mac' | 'notMac' | 'autoUpdate' | 'acceleration'
export interface SettingsItem {
  /** 设置页上那一行的 data-anchor：顶部搜索点了靠它翻到那一行，不能和分组的 value 撞名。 */
  id: string
  group: SettingsGroupId
  /** 组里的哪个小标题下面；缺省 = 不带标题的那张卡。 */
  section?: SettingsSectionId
  /** 那一行的标题，设置页和顶部搜索读同一份。 */
  label: string
  /** 顶部搜索和设置页里的搜索用的常用说法，界面上不显示。 */
  keywords: readonly string[]
  when?: SettingsItemCondition
  /**
   * 这一项是一整张卡（游戏加速、工具配置备份、版本卡），不是卡里的一行：页面上单独摆，
   * 不和挨着的行装进同一张卡。原来是三个页面，v4 并进设置（批09）。缺省 = 普通的一行。
   */
  card?: boolean
}
/**
 * 设置里的每一行，按页面上的顺序。顶部搜索按行出结果（「版本更新 › 自动更新」），
 * 点了打开那一组、翻到那一行；页面上的行标题也从这里取，两边不会说成两个名字。
 */
export const settingsItems: readonly SettingsItem[] = [
  { id: 'theme', group: 'appearance', label: '主题', keywords: ['深色', '浅色', '夜间', '暗色', '白色', '配色', '皮肤', '跟随系统'] },
  { id: 'ui-scale', group: 'appearance', section: 'text-scale', label: '界面缩放', keywords: ['缩放', '放大', '缩小', '太大', '太小'] },
  { id: 'large-text', group: 'appearance', section: 'text-scale', label: '大字', keywords: ['字体', '字号', '字太小', '看不清'] },
  { id: 'language', group: 'appearance', section: 'text-scale', label: '界面语言', keywords: ['中文'] },
  { id: 'high-contrast', group: 'appearance', section: 'display', label: '高对比度', keywords: ['看不清'] },
  { id: 'reduced-motion', group: 'appearance', section: 'display', label: '减少动画', keywords: ['动效'] },
  { id: 'hardware-acceleration', group: 'appearance', section: 'display', label: '用显卡加速显示', keywords: ['黑屏', '花屏', '闪烁', '闪退', '显卡'] },
  { id: 'restore-appearance', group: 'appearance', section: 'display', label: '恢复默认外观', keywords: ['重置', '默认'] },
  { id: 'launch-at-login', group: 'startup', label: '开机自动启动', keywords: ['开机', '自启'] },
  { id: 'close-behavior', group: 'startup', label: '点关闭按钮时', keywords: ['托盘', '最小化', '关闭'] },
  { id: 'startup-diagnostics', group: 'startup', label: '启动时检查环境', keywords: [] },
  { id: 'workspace', group: 'tools', label: '打开工具时进入的文件夹', keywords: ['工作文件夹', '项目文件夹', '默认文件夹'] },
  { id: 'latest-cli', group: 'tools', label: '命令行工具总是装最新版', keywords: ['最新版', '推荐版本'] },
  { id: 'install-location', group: 'tools', label: '安装位置', keywords: ['装在哪'] },
  { id: 'terminal', group: 'tools', label: '终端', keywords: ['命令行'] },
  { id: 'acceleration', group: 'network', label: '游戏加速', keywords: ['加速', '游戏', '延迟', '卡顿', '免费时长', '加速线路'], when: 'acceleration', card: true },
  ...connectionRouteSettings.map((route): SettingsItem => ({ id: route.id, group: 'network', section: 'routes', label: route.label, keywords: ['线路', '线路1', '线路2', '直连', '洛杉矶', 'CF', '备用', '重启', '连不上'] })),
  { id: 'tool-route-restart-hints', group: 'network', section: 'routes', label: '换线路后提醒我重开工具', keywords: ['线路', '重开', '需重开生效'] },
  { id: 'mirror', group: 'network', section: 'download', label: '下载来源', keywords: ['镜像', '下载慢', '国内', '官方源'] },
  { id: 'proxy', group: 'network', section: 'download', label: '连接方式', keywords: ['网络连接', '代理', 'VPN', '梯子'] },
  { id: 'network-check', group: 'network', section: 'download', label: '网络检查', keywords: [] },
  { id: 'certificate', group: 'network', section: 'download', label: '企业证书', keywords: ['证书', '公司电脑'] },
  // 「发测试通知」并进了这一行，原来搜「测试通知」的说法跟过来。
  { id: 'desktop-notifications', group: 'notifications', label: '桌面通知', keywords: ['测试通知', '通知不弹', '收不到通知'] },
  ...notificationOptions.map((option): SettingsItem => ({
    id: notificationSettingsItemId(option.value),
    group: 'notifications',
    section: 'reminders',
    label: option.label,
    keywords: [],
    ...(option.value === 'acceleration' ? { when: 'acceleration' as const } : {}),
  })),
  { id: 'backups', group: 'backup', label: '工具配置备份', keywords: ['备份', '恢复', '还原', '找回配置', '立即备份'], card: true },
  // 没登录时只能导设置，那一行写「导出设置」（页面上换）；这里的标题给顶部搜索用。
  { id: 'transfer', group: 'backup', section: 'transfer', label: '导出设置和聊天记录', keywords: ['导出', '换电脑', '新电脑', '迁移', '聊天记录', '搬到新电脑'] },
  { id: 'transfer-import', group: 'backup', section: 'transfer', label: '从文件导入', keywords: ['导入', '换电脑', '新电脑', '迁移', '搬到新电脑'] },
  { id: 'crash-reporting', group: 'privacy', label: '崩溃自动上报', keywords: [] },
  { id: 'usage-stats', group: 'privacy', label: '匿名使用统计', keywords: [] },
  { id: 'logs', group: 'privacy', label: '运行日志', keywords: ['日志', '报告'] },
  { id: 'legal', group: 'privacy', label: '用户协议与隐私政策', keywords: [] },
  { id: 'version', group: 'about', label: '检查更新', keywords: ['当前版本', '版本号', '版本', '升级', '新版本', '下载更新', '更新内容'], card: true },
  { id: 'update-check', group: 'about', label: '启动时检查新版本', keywords: ['检查更新', '升级', '新版本'] },
  { id: 'auto-update', group: 'about', label: '自动下载更新', keywords: ['自动更新', '检查更新', '升级', '新版本'], when: 'autoUpdate' },
  { id: 'shortcuts', group: 'about', label: '快捷键', keywords: ['快捷键', '键盘'] },
  { id: 'guide', group: 'about', label: '新手引导', keywords: ['引导', '新手', '从头'] },
  { id: 'tour', group: 'about', label: '界面导览', keywords: [] },
  { id: 'uninstall-app', group: 'about', label: '卸载星芒', keywords: ['卸载星芒', '删除软件'], when: 'mac' },
  { id: 'uninstall', group: 'about', label: '卸载星芒', keywords: ['卸载星芒', '删除软件'], when: 'notMac' },
]
export function notificationSettingsItemId(kind: PlatformNotificationKind): string {
  return `notify-${kind}`
}
/** 设置页某一行的标题；id 写错是开发时的错，直接抛出来，不让页面悄悄少一个字。 */
export function settingsItemLabel(id: string): string {
  const item = settingsItems.find((entry) => entry.id === id)
  if (!item) throw new Error(`settings item ${id} is not registered`)
  return item.label
}
export interface SettingsItemContext {
  mac: boolean
  autoUpdate: boolean
  acceleration: boolean
}
/** 这一行在这台电脑上有没有。没有的不出现在顶部搜索里。 */
export function settingsItemAvailable(item: SettingsItem, context: SettingsItemContext): boolean {
  if (item.when === 'mac') return context.mac
  if (item.when === 'notMac') return !context.mac
  if (item.when === 'autoUpdate') return context.autoUpdate
  if (item.when === 'acceleration') return context.acceleration
  return true
}
export interface SettingsBlock {
  /** 这张卡上面的小标题；缺省 = 不带标题。 */
  section?: (typeof settingsSections)[number]
  items: SettingsItem[]
}
/** 一组在页面上分成几张卡：挨着的几行 section 相同就放进同一张；整张卡的那一项（card）自己一块。 */
export function buildSettingsBlocks(group: SettingsGroupId, items: readonly SettingsItem[] = settingsItems): SettingsBlock[] {
  const blocks: SettingsBlock[] = []
  for (const item of items) {
    if (item.group !== group) continue
    const last = blocks[blocks.length - 1]
    if (last && !item.card && !last.items[0].card && last.section?.value === item.section) last.items.push(item)
    else blocks.push({ section: settingsSections.find((section) => section.value === item.section), items: [item] })
  }
  return blocks
}
/**
 * 设置页左栏「搜索设置」：按行名、常用说法、组名和小标题找，空格隔开的几个词都要对上；
 * 次序和页面上一样。没输字返回空，页面照常显示当前那一组。
 */
export function searchSettingsItems(query: string, items: readonly SettingsItem[] = settingsItems): SettingsItem[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  return items.filter((item) => {
    const group = settingsGroups.find((entry) => entry.value === item.group)?.label ?? ''
    const section = settingsSections.find((entry) => entry.value === item.section)?.label ?? ''
    const text = [item.label, ...item.keywords, group, section].join(' ').toLowerCase()
    return words.every((word) => text.includes(word))
  })
}

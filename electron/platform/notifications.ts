import { accelerationExpiryWarningSeconds } from '../acceleration-contract'
import type {
  PlatformActivityDetail,
  PlatformActivityKind,
  PlatformInstallNotice,
  PlatformNotificationKind,
  PlatformNotificationPreferences,
  PlatformNotificationResult,
  PlatformSpendNotice,
} from './contract'

export interface PlatformNotificationHandle {
  on(
    event: 'click' | 'close' | 'failed',
    listener: (...args: unknown[]) => void,
  ): unknown
  show(): void
  close(): void
  removeAllListeners(): unknown
}
export interface PlatformNotificationRuntime {
  supported(): boolean
  create(options: {
    title: string
    body: string
    silent: boolean
  }): PlatformNotificationHandle
}
/** 主进程自己发的通知；渲染层没有通道能请求它们。 */
export type PlatformHostNotification =
  | 'accelerationExpiring'
  | 'accelerationExhausted'
  | 'accelerationInterrupted'
  | 'accelerationInterruptedUnrestored'
  | 'hiddenToTray'
  | 'hiddenToMenuBar'
  | 'hiddenToPanel'
  | 'paymentSettled'

export interface NotificationMessage {
  title: string
  body: string
}

/**
 * 点通知后主窗口停在哪一页。去处由主进程按通知种类和编号前缀定死，渲染层
 * 请求通知时没有办法指定页面，所以拿到通知通道的页面也只能把人带到这几处。
 */
export type PlatformNotificationTarget =
  | 'home'
  | 'chat'
  | 'tasks'
  | 'topup'
  | 'announcement'
  | 'usage'
  | 'health'

const messages = {
  test: { title: '星芒测试通知', body: '这是一条测试通知，可在设置中关闭。' },
  install: {
    title: '工具已准备好',
    body: '安装或更新已经完成，可以回到星芒工具箱查看。',
  },
  balance: {
    title: '余额需要留意',
    body: '星芒余额不足 $5，可以在个人中心查看和充值。',
  },
  task: {
    title: '异步任务已完成',
    body: '任务结果已经更新，可以回到星芒工具箱查看。',
  },
  // 具体是哪几个工具、更到哪个版本，界面上的「你的工具」已经逐行写着；
  // 通知只负责把人叫回来，不重复那份清单，也不带版本号。
  cliUpdate: {
    title: '命令行工具有新版本',
    body: '你装的工具出了新版本，回到星芒的「你的工具」就能逐个更新。',
  },
  // 公告正文可能很长、也可能带图，通知里只说有新公告，点开回到星芒看全文。
  announcement: {
    title: '有新公告',
    body: '当前账号有一条新公告，回到星芒就能看到。',
  },
  // 正常总会带着金额（ipc.ts 不放行空的）；这句只是类型上的兜底。
  spend: {
    title: '这一小时花得比平时多',
    body: '如果不是你在用，回星芒看看是哪个工具。',
  },
} as const satisfies Record<PlatformActivityKind | 'test', NotificationMessage>

// 聊天和出图也借 task 这一类的偏好开关，但人不是去「异步任务」里看结果，
// 所以按编号前缀换成自己的说法。前缀由星芒自己的聊天页写死（chat: / image:）。
const chatMessages = {
  chat: { title: 'AI 回复好了', body: '回到星芒的「聊天」查看。' },
  image: { title: '图片生成好了', body: '回到星芒的「聊天」查看。' },
} as const satisfies Record<string, NotificationMessage>

// 充值活动也借「公告」这一类的偏好开关，说法换成活动自己的。编号前缀由首页的活动卡片写死
// （promo: 活动开始，promo-daily: 每天第一次提醒）。活动的标题和正文不进通知：点开回到首页看卡片。
const promoMessages = {
  arrival: { title: '有新的充值活动', body: '当前账号有一个充值活动，回到星芒首页看看，点「去充值」就能参加。' },
  daily: { title: '充值活动还在进行', body: '当前账号的充值活动还没结束，回到星芒首页看看。' },
} as const satisfies Record<string, NotificationMessage>

function promoNoticeKind(eventKey: string): keyof typeof promoMessages | null {
  if (eventKey.startsWith('promo:')) return 'arrival'
  if (eventKey.startsWith('promo-daily:')) return 'daily'
  return null
}

function chatNoticeKind(eventKey: string): keyof typeof chatMessages | null {
  if (eventKey.startsWith('chat:')) return 'chat'
  if (eventKey.startsWith('image:')) return 'image'
  return null
}

export function resolveNotificationTarget(
  kind: PlatformActivityKind | 'test',
  eventKey: string,
): PlatformNotificationTarget | null {
  switch (kind) {
    case 'balance':
      return 'topup'
    case 'task':
      return chatNoticeKind(eventKey) ? 'chat' : 'tasks'
    case 'install':
    case 'cliUpdate':
      return 'home'
    case 'announcement':
      return promoNoticeKind(eventKey) ? 'home' : 'announcement'
    case 'spend':
      return 'usage'
    case 'test':
      return null
  }
}

export function buildActivityNotificationMessage(
  kind: PlatformActivityKind | 'test',
  eventKey: string,
  detail?: PlatformActivityDetail,
): NotificationMessage {
  if (kind === 'install' && detail && 'tool' in detail) return buildInstallNotificationMessage(detail)
  if (kind === 'spend' && detail && 'cents' in detail) return buildSpendNotificationMessage(detail)
  const chat = kind === 'task' ? chatNoticeKind(eventKey) : null
  if (chat) return chatMessages[chat]
  const promo = kind === 'announcement' ? promoNoticeKind(eventKey) : null
  return promo ? promoMessages[promo] : messages[kind]
}

// 金额按美元两位小数写，同余额的写法；倍数只给整数，「大约」已经说明是估的。
export function buildSpendNotificationMessage(
  notice: PlatformSpendNotice,
): NotificationMessage {
  const amount = `$${Math.floor(notice.cents / 100)}.${String(notice.cents % 100).padStart(2, '0')}`
  const compared = notice.multiple === null ? '比平时多很多' : `大约是平时的 ${notice.multiple} 倍`
  return {
    title: messages.spend.title,
    body: `过去一小时用掉了 ${amount}，${compared}。${messages.spend.body}`,
  }
}

// 渲染层只给编号，名字在这里定死：拿到这条通道的页面也只能在这份名单里挑，
// 塞不进任意文字。名单外的编号（以后新加了工具忘了补）就说「工具」，不报错。
const installToolNames: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  gemini: 'Gemini CLI',
  grok: 'Grok CLI',
  codexDesktop: 'Codex 桌面端',
  node: '运行环境',
  python: 'Python',
  git: 'Git',
  workbuddy: 'WorkBuddy',
  claudeDesktop: 'Claude Desktop',
  opencode: 'OpenCode',
}

export function buildInstallNotificationMessage(
  notice: PlatformInstallNotice,
): NotificationMessage {
  const name = Object.hasOwn(installToolNames, notice.tool)
    ? installToolNames[notice.tool]!
    : '工具'
  // 「Claude Code 装好了」「运行环境装好了」：英文名后面空一格，中文名直接接。
  const subject = /[A-Za-z]$/.test(name) ? `${name} ` : name
  switch (notice.outcome) {
    case 'installed':
      return { title: `${subject}装好了`, body: '回到星芒就能打开使用。' }
    case 'updated':
      return { title: `${subject}已经更新好了`, body: '回到星芒就能接着用。' }
    case 'installFailed':
      return {
        title: `${subject}没装上`,
        body: '回到星芒看看原因，照提示点一下就能重试。',
      }
    case 'updateFailed':
      return {
        title: `${subject}没更新好`,
        body: '回到星芒看看原因，照提示点一下就能重试。',
      }
  }
}

// 一条只说「还剩多久」，一条只说「已经断开了」：用户在游戏里看到的就这一行，
// 多一个字的引导都会把它变成广告。免费时长怎么卖不是这里的事，所以不写价格、
// 不写充值入口。主语是「当前账号」，不出现站点名。
// kind 为 null 的通知不归哪一类偏好管，只看总开关：它不是「发生了什么事」，
// 而是告诉用户窗口去哪了，一台电脑只说一次。
const hostMessages: Record<
  PlatformHostNotification,
  NotificationMessage & { kind: PlatformNotificationKind | null }
> = {
  accelerationExpiring: {
    kind: 'acceleration',
    title: `加速还剩 ${accelerationExpiryWarningSeconds / 60} 分钟`,
    body: '当前账号的免费加速时长快用完了，用完会自动断开。',
  },
  accelerationExhausted: {
    kind: 'acceleration',
    title: '加速已断开',
    body: '当前账号的免费加速时长已用完，加速已自动断开。',
  },
  // 不是用户点的断开。先说网络的现状，因为那是他此刻最关心的：浏览器、微信还
  // 能不能用。「已恢复正常」只在确实读到会话停了之后才说。
  accelerationInterrupted: {
    kind: 'acceleration',
    title: '加速意外断开了',
    body: '网络已恢复正常，可以回到加速页重新连接。',
  },
  accelerationInterruptedUnrestored: {
    kind: 'acceleration',
    title: '加速意外断开了',
    body: '网络可能暂时连不上，点这里回到加速页，星芒会再试着恢复。',
  },
  // Windows 11 默认把新托盘图标收进任务栏右边的 ^ 里，小白找不到窗口会以为软件没了。
  hiddenToTray: {
    kind: null,
    title: '星芒AI管理工具还在运行',
    body: '窗口缩到了右下角的托盘里，点星芒图标就能打开。看不到图标的话，点任务栏右边的小箭头 ^。',
  },
  hiddenToMenuBar: {
    kind: null,
    title: '星芒AI管理工具还在运行',
    body: '窗口已收起，点屏幕顶部菜单栏里的星芒图标就能打开。',
  },
  // Linux 各家桌面放托盘图标的地方不一样：Ubuntu 在屏幕右上角，KDE、deepin、UKUI 在
  // 任务栏右边，所以两处都说。没有托盘的桌面根本不会缩进去（linux-tray-host.ts）。
  hiddenToPanel: {
    kind: null,
    title: '星芒AI管理工具还在运行',
    body: '窗口已收起，点屏幕顶部或任务栏右边的星芒图标就能打开。',
  },
  // 客户关了支付窗口以后才确认到账。钱是他自己刚付的，不归「余额不足」那类提醒管，
  // 只看总开关。订单号不写进通知：通知中心谁都看得见，点进来「充值与订阅」页写着。
  paymentSettled: {
    kind: null,
    title: '付款已到账',
    body: '刚才那笔订单已到账，余额和订阅已更新。',
  },
}

/**
 * 终端里的命令行工具（Claude Code、Gemini CLI、Grok）出了什么事。只有主进程从钩子记录里
 * 读出来的固定类型词，没有任何 CLI 递来的原文，所以通知里的每个字都出自下面这张表。
 */
export type TerminalFailureReason = 'billing' | 'auth' | 'busy' | 'model' | 'service' | 'unknown'
export type TerminalNotice =
  | { tool: 'claude' | 'gemini' | 'grok'; event: 'failed'; reason: TerminalFailureReason }
  | { tool: 'claude' | 'gemini' | 'grok'; event: 'waiting' }
  // Codex 的 notify 只在一轮顺利做完时调用，出错和等人都没有，所以只有「做完了」。
  | { tool: 'claude' | 'gemini' | 'codex' | 'grok'; event: 'finished' }

const terminalToolNames: Record<TerminalNotice['tool'], string> = {
  claude: 'Claude Code',
  gemini: 'Gemini CLI',
  codex: 'Codex',
  grok: 'Grok',
}

// 主语是「当前账号」；订阅客户也会碰到额度用完，所以不说「余额」，只说「额度」。
const terminalFailureBodies: Record<TerminalFailureReason, string> = {
  billing: '当前账号的额度不够了，点这里去充值或续订，弄好后回终端再发一次。',
  auth: '当前账号的 Key 用不了了，点这里回星芒检查，照提示点一下就能重新连上。',
  busy: '现在用的人太多，服务一时忙不过来。等一两分钟再在终端里发一次就行。',
  model: '现在选的型号用不了，点这里回星芒检查，换一个能用的型号。',
  service: '服务暂时出了问题，可能在维护。稍等几分钟再试，一直不好就点这里检查一下。',
  // 工具自己也说不清原因（额度用完常常落在这一类），就不猜，请用户回来查一下。
  unknown: '点这里回星芒检查一下，看看是额度、Key 还是服务的问题，照提示点一下就好。',
}

export function buildTerminalNotificationMessage(
  notice: TerminalNotice,
): NotificationMessage {
  const name = terminalToolNames[notice.tool]
  switch (notice.event) {
    case 'failed':
      return {
        title: `${name} 刚才没回上`,
        body: terminalFailureBodies[notice.reason],
      }
    case 'waiting':
      return {
        title: `${name} 在等你`,
        body: '它停下来等你确认，回到终端窗口看一眼就能接着干。',
      }
    case 'finished':
      return {
        title: `${name} 做完了`,
        body: '这一轮跑了一分多钟，已经做完了，回到终端窗口看看结果。',
      }
  }
}

/** 额度不够去充值；其余出错去检查页。做完和等人要回的是终端，星芒这边不换页。 */
export function resolveTerminalNotificationTarget(
  notice: TerminalNotice,
): PlatformNotificationTarget | null {
  if (notice.event !== 'failed') return null
  return notice.reason === 'billing' ? 'topup' : 'health'
}

function terminalNotificationKind(
  notice: TerminalNotice,
): PlatformNotificationKind {
  return notice.event === 'failed' ? 'cliTrouble' : 'cliTurn'
}

/** 窗口第一次缩起来时说它去了哪儿：Windows 托盘、macOS 菜单栏、Linux 顶栏或任务栏。 */
export function hiddenWindowNotification(platform: NodeJS.Platform): PlatformHostNotification {
  if (platform === 'win32') return 'hiddenToTray'
  if (platform === 'darwin') return 'hiddenToMenuBar'
  return 'hiddenToPanel'
}

/** 系统通知发不出去时，宿主改用别的办法（Windows 托盘气泡）说同一句话。 */
export function hostNotificationMessage(event: PlatformHostNotification): NotificationMessage {
  const { title, body } = hostMessages[event]
  return { title, body }
}

export function createPlatformNotifications(
  options: {
    readEnabled: () => boolean
    readPreferences: () => PlatformNotificationPreferences
    focusMainWindow: () => void
    /** 缺省时点通知只把窗口叫出来（旧行为）。 */
    openPage?: (target: PlatformNotificationTarget) => void
    onError: (error: unknown) => void
  },
  runtime: PlatformNotificationRuntime,
) {
  const seen = new Set<string>()
  const active = new Set<PlatformNotificationHandle>()
  const report = (error: unknown) => {
    try {
      options.onError(error)
    } catch {
      /* Native events must not throw. */
    }
  }
  const present = (
    kind: PlatformNotificationKind | 'test' | null,
    key: string,
    message: NotificationMessage,
    onClick?: () => void,
  ): PlatformNotificationResult => {
    if (
      !options.readEnabled() ||
      (kind !== 'test' && kind !== null && !options.readPreferences()[kind])
    )
      return 'disabled'
    if (!runtime.supported()) return 'unsupported'
    if (kind !== 'test' && seen.has(key)) return 'duplicate'
    const notification = runtime.create({ ...message, silent: true })
    while (active.size >= 4) {
      const oldest = active.values().next().value!
      active.delete(oldest)
      oldest.removeAllListeners()
      oldest.close()
    }
    const release = () => {
      active.delete(notification)
      notification.removeAllListeners()
    }
    notification.on('click', () => {
      try {
        options.focusMainWindow()
        onClick?.()
      } catch (error) {
        report(error)
      }
    })
    notification.on('close', release)
    notification.on('failed', (_event, reason) => {
      seen.delete(key)
      release()
      report(
        new Error(
          typeof reason === 'string'
            ? reason.slice(0, 200)
            : '系统通知没有显示。',
        ),
      )
    })
    active.add(notification)
    if (kind !== 'test') {
      seen.add(key)
      while (seen.size > 64) seen.delete(seen.values().next().value!)
    }
    try {
      notification.show()
    } catch (error) {
      seen.delete(key)
      release()
      throw error
    }
    return 'requested'
  }
  return {
    notify: (
      kind: PlatformActivityKind | 'test',
      eventKey: string,
      detail?: PlatformActivityDetail,
    ) => {
      const target = resolveNotificationTarget(kind, eventKey)
      const openPage = options.openPage
      return present(
        kind,
        `${kind}:${eventKey}`,
        buildActivityNotificationMessage(kind, eventKey, detail),
        target && openPage ? () => openPage(target) : undefined,
      )
    },
    notifyHost: (
      event: PlatformHostNotification,
      eventKey: string,
      onClick?: () => void,
    ) => {
      // 只把标题与正文交给系统通知：kind 是偏好开关的键，不该出现在通知参数里。
      const { kind, title, body } = hostMessages[event]
      return present(kind, `${event}:${eventKey}`, { title, body }, onClick)
    },
    notifyTerminal: (notice: TerminalNotice, eventKey: string) => {
      const target = resolveTerminalNotificationTarget(notice)
      const openPage = options.openPage
      return present(
        terminalNotificationKind(notice),
        `terminal:${eventKey}`,
        buildTerminalNotificationMessage(notice),
        target && openPage ? () => openPage(target) : undefined,
      )
    },
    dispose: () => {
      for (const notification of active) {
        notification.removeAllListeners()
        notification.close()
      }
      active.clear()
      seen.clear()
    },
  }
}

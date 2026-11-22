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
  | 'codexPayloadSwitched'
  | 'codexPayloadTooLarge'
  | 'codexPayloadLineTwoTooLarge'
  | 'codexPayloadNearing'

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
    body: '安装或更新已完成，请返回星芒查看。',
  },
  balance: {
    title: '余额不足提醒',
    body: '星芒余额不足 $5，请前往个人中心查看并充值。',
  },
  task: {
    title: '生成任务已完成',
    body: '任务结果已更新，请返回星芒查看。',
  },
  // 具体是哪几个工具、更到哪个版本，首页的工具卡片上已经各自写着；
  // 通知只负责把人叫回来，不重复那份清单，也不带版本号。
  // 标题不说「命令行」：Codex 桌面端出新版也走这一条，只装了桌面端的客户
  // 一个命令行工具都没有，看到「命令行工具有新版本」会以为发错了人。
  cliUpdate: {
    title: '工具有新版本',
    body: '您安装的工具有新版本，请返回星芒首页逐个更新。',
  },
  // 公告正文可能很长、也可能带图，通知里只说有新公告，点开回到星芒看全文。
  announcement: {
    title: '有新公告',
    body: '当前账号有一条新公告，请返回星芒查看。',
  },
  // 正常总会带着金额（ipc.ts 不放行空的）；这句只是类型上的兜底。
  spend: {
    title: '近一小时消费高于平时',
    body: '如非本人使用，请返回星芒查看具体工具。',
  },
} as const satisfies Record<PlatformActivityKind | 'test', NotificationMessage>

// 聊天和出图也借 task 这一类的偏好开关，但人不是去「异步任务」里看结果，
// 所以按编号前缀换成自己的说法。前缀由星芒自己的聊天页写死（chat: / image:）。
const chatMessages = {
  chat: { title: 'AI 回复已完成', body: '请返回星芒的「创作」页查看。' },
  image: { title: '图片已生成', body: '请返回星芒的「创作」页查看。' },
} as const satisfies Record<string, NotificationMessage>

// 充值活动也借「公告」这一类的偏好开关，说法换成活动自己的。编号前缀由首页的活动卡片写死
// （promo: 活动开始，promo-daily: 每天第一次提醒）。活动的标题和正文不进通知：点开回到首页看卡片。
const promoMessages = {
  arrival: { title: '有新的充值活动', body: '当前账号有一项充值活动，请返回星芒首页，点击「前往充值」参与。' },
  daily: { title: '充值活动进行中', body: '当前账号的充值活动尚未结束，请返回星芒首页查看。' },
} as const satisfies Record<string, NotificationMessage>

// 钱包到了 $0、又没有能扣的订阅（主进程 empty-balance-alert.ts 判断，编号前缀 balance-empty:），借「余额」
// 这一类的偏好开关。Codex 这时只会在终端里转圈重连、像是网断了，这条是它唯一的提醒，所以把那个样子说出来。
const emptyBalanceMessage = {
  title: '当前账号余额为 $0',
  body: 'AI 工具当前无法使用，部分工具会持续重连，看似网络已断开。请点击此处充值，付款后立即生效，返回工具重新发送即可。',
} as const satisfies NotificationMessage

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
  if (kind === 'balance' && eventKey.startsWith('balance-empty:')) return emptyBalanceMessage
  const promo = kind === 'announcement' ? promoNoticeKind(eventKey) : null
  return promo ? promoMessages[promo] : messages[kind]
}

// 金额按美元两位小数写，同余额的写法；倍数只给整数，「大约」已经说明是估的。
export function buildSpendNotificationMessage(
  notice: PlatformSpendNotice,
): NotificationMessage {
  const amount = `$${Math.floor(notice.cents / 100)}.${String(notice.cents % 100).padStart(2, '0')}`
  const compared = notice.multiple === null ? '远高于平时' : `约为平时的 ${notice.multiple} 倍`
  return {
    title: messages.spend.title,
    body: `过去一小时消费 ${amount}，${compared}。${messages.spend.body}`,
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
      return { title: `${subject}已安装`, body: '请返回星芒打开使用。' }
    case 'updated':
      return { title: `${subject}已更新`, body: '请返回星芒继续使用。' }
    case 'installFailed':
      return {
        title: `${subject}安装失败`,
        body: '请返回星芒查看原因，并按提示重试。',
      }
    case 'updateFailed':
      return {
        title: `${subject}更新失败`,
        body: '请返回星芒查看原因，并按提示重试。',
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
    body: '当前账号的免费加速时长即将用完，用完后将自动断开。',
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
    title: '加速意外断开',
    body: '网络已恢复，请前往「设置 › 网络加速」重新连接。',
  },
  accelerationInterruptedUnrestored: {
    kind: 'acceleration',
    title: '加速意外断开',
    body: '网络可能暂时无法连接，请点击此处打开网络加速，星芒将尝试恢复。',
  },
  // Windows 11 默认把新托盘图标收进任务栏右边的 ^ 里，小白找不到窗口会以为软件没了。
  hiddenToTray: {
    kind: null,
    title: '星芒AI管理工具仍在运行',
    body: '窗口已缩到右下角的托盘，点击星芒图标即可打开。如未看到图标，请点击任务栏右侧的小箭头 ^。',
  },
  // 带刘海的 MacBook 上菜单栏图标一多，星芒的就被刘海挡住；程序坞那条路一直在（深查 TR-5、决定单 D30）。
  hiddenToMenuBar: {
    kind: null,
    title: '星芒AI管理工具仍在运行',
    body: '窗口已收起，点击屏幕顶部菜单栏或程序坞中的星芒图标即可打开。',
  },
  // Linux 各家桌面放托盘图标的地方不一样：Ubuntu 在屏幕右上角，KDE、deepin、UKUI 在
  // 任务栏右边，所以两处都说。没有托盘的桌面根本不会缩进去（linux-tray-host.ts）。
  hiddenToPanel: {
    kind: null,
    title: '星芒AI管理工具仍在运行',
    body: '窗口已收起，点击屏幕顶部或任务栏右侧的星芒图标即可打开。',
  },
  // 客户关了支付窗口以后才确认到账。钱是他自己刚付的，不归「余额不足」那类提醒管，
  // 只看总开关。订单号不写进通知：通知中心谁都看得见，点进来「充值与订阅」页写着。
  paymentSettled: {
    kind: null,
    title: '付款已到账',
    body: '该订单已到账，余额和订阅已更新。',
  },
  // Codex 有个对话太大、发不出去（codex-payload-limit.ts）。客户这会儿多半正对着 Codex 一遍遍重试，星芒角落那张
  // 卡看不见，所以另发一条；归「终端里没回上」那个开关管。点开回到星芒，那张卡上写着怎么办。
  codexPayloadSwitched: {
    kind: 'cliTrouble',
    title: 'Codex 对话已切换至线路2',
    body: '该对话已超过线路1 的 100MB 上限，已为您切换至线路2。请完全退出 Codex 后重新打开，即可继续对话。',
  },
  codexPayloadTooLarge: {
    kind: 'cliTrouble',
    title: 'Codex 对话体积过大，无法发送',
    body: '该对话已超过 100MB，无法通过线路1 发送。请新建对话继续，点击此处查看原因。',
  },
  codexPayloadLineTwoTooLarge: {
    kind: 'cliTrouble',
    title: 'Codex 对话体积过大，无法发送',
    body: '请新建对话继续，点击此处查看原因。',
  },
  codexPayloadNearing: {
    kind: 'cliTrouble',
    title: 'Codex 中有对话即将达到线路1 的上限',
    body: '超过 100MB 后将无法通过线路1 发送，建议完成当前任务后新建对话。',
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
  billing: '当前账号额度不足，请点击此处充值或续订，完成后返回终端重新发送。',
  auth: '当前账号的密钥不可用，请点击此处返回星芒检查，按提示操作即可重新连接。',
  busy: '当前使用人数较多，服务繁忙。请稍候一两分钟后在终端中重新发送。',
  model: '当前所选模型不可用，请点击此处返回星芒检查，并更换可用的模型。',
  service: '服务暂时异常，可能正在维护。请稍候几分钟后重试，如持续异常请点击此处检查。',
  // 工具自己也说不清原因，就不猜，请用户回来查一下。中转说余额用完时 Claude Code 报的是
  // authentication_failed，钩子脚本看过原文改报 billing（xingmang-hook.cjs 的 balanceExhausted）。
  unknown: '请点击此处返回星芒检查，确认是额度、密钥还是服务的问题，并按提示处理。',
}

export function buildTerminalNotificationMessage(
  notice: TerminalNotice,
): NotificationMessage {
  const name = terminalToolNames[notice.tool]
  switch (notice.event) {
    case 'failed':
      return {
        title: `${name} 未能回复`,
        body: terminalFailureBodies[notice.reason],
      }
    case 'waiting':
      return {
        title: `${name} 等待您确认`,
        body: '工具已暂停并等待您确认，请返回终端窗口查看后继续。',
      }
    case 'finished':
      return {
        title: `${name} 已完成`,
        body: '本轮任务运行超过一分钟，现已完成，请返回终端窗口查看结果。',
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
            : '系统通知未能显示。',
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

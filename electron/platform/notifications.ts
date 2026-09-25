import { accelerationExpiryWarningSeconds } from '../acceleration-contract'
import type {
  PlatformActivityKind,
  PlatformInstallNotice,
  PlatformNotificationKind,
  PlatformNotificationPreferences,
  PlatformNotificationResult,
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
  | 'accelerationAutoStarted'
  | 'hiddenToTray'
  | 'hiddenToMenuBar'

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
} as const satisfies Record<PlatformActivityKind | 'test', NotificationMessage>

// 聊天和出图也借 task 这一类的偏好开关，但人不是去「异步任务」里看结果，
// 所以按编号前缀换成自己的说法。前缀由星芒自己的聊天页写死（chat: / image:）。
const chatMessages = {
  chat: { title: 'AI 回复好了', body: '回到星芒的「聊天」查看。' },
  image: { title: '图片生成好了', body: '回到星芒的「聊天」查看。' },
} as const satisfies Record<string, NotificationMessage>

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
      return 'announcement'
    case 'test':
      return null
  }
}

export function buildActivityNotificationMessage(
  kind: PlatformActivityKind | 'test',
  eventKey: string,
  install?: PlatformInstallNotice,
): NotificationMessage {
  if (kind === 'install' && install) return buildInstallNotificationMessage(install)
  const chat = kind === 'task' ? chatNoticeKind(eventKey) : null
  return chat ? chatMessages[chat] : messages[kind]
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
  // 关掉桌面端不会跟着断开，所以要说清三件事：开着、在计时、在哪断开。
  accelerationAutoStarted: {
    kind: 'acceleration',
    title: '已为 Codex 桌面端连上加速',
    body: '打开桌面端时自动连上的，会计入免费加速时长，不用时可以在托盘或加速页断开。',
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
      install?: PlatformInstallNotice,
    ) => {
      const target = resolveNotificationTarget(kind, eventKey)
      const openPage = options.openPage
      return present(
        kind,
        `${kind}:${eventKey}`,
        buildActivityNotificationMessage(kind, eventKey, install),
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

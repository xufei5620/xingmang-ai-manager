import { cliCatalog, isProviderId } from './catalog'
import { externalClientNames, isExternalToolId } from './external-client-contract'
import type { InstallationQueueSnapshot } from './installation-queue'
import type { RendererRestartWork } from './ipc-contract'
import { updateInstallLaunchTimeoutCode, type UpdateSnapshot } from './updater'

export interface InterruptibleInstallTask {
  /** 队列 key，只用于日志与测试，不面向用户。 */
  key: string
  /** 面向用户的一句话，例如「正在安装 Claude Code」。 */
  description: string
  /** 队列里同类任务的总数，含正在跑的那一个。 */
  count: number
}

const cliInstallPrefix = 'cli:install:'
const externalClientInstallPrefix = 'external-client:install:'

/**
 * 安装类任务被打断不会留下半成品（I11 的原子替换），但已经下载的几十兆白费，
 * 下次打开首页显示的还是旧版本，用户会以为「更新没成功」。所以只有这一类
 * 值得在退出前拦一下；启动 CLI、打开桌面端、卸载都只是拉起进程或删目录，
 * 被打断没有后果，不该拦住退出。
 *
 * Git 和 WorkBuddy、Claude Desktop、OpenCode 三个客户端同样算安装类：Windows 上装完
 * Claude Code 会接着装 Git，进度条还在走，客户最容易这时退出；三个客户端交给 winget 或
 * 官方安装程序去装，那一步被打断还可能留下装了一半的程序，不止白下。防睡
 * （install-keep-awake.ts）认的也是这几类，两边要一起改，不然就成了「电脑不睡了，退出却不拦」。
 */
function describeInstallTask(key: string): string | null {
  if (key === 'runtime:node') return '正在安装 Node.js 运行环境'
  if (key === 'runtime:python') return '正在安装 Python 运行环境'
  if (key === 'runtime:git') return '正在安装 Git'
  if (key === 'desktop:codex:install') return '正在安装 Codex 桌面端'
  if (key.startsWith(externalClientInstallPrefix)) {
    const tool = key.slice(externalClientInstallPrefix.length)
    return isExternalToolId(tool) ? `正在安装 ${externalClientNames[tool]}` : null
  }
  if (!key.startsWith(cliInstallPrefix)) return null
  const provider = key.slice(cliInstallPrefix.length)
  return isProviderId(provider) ? `正在安装 ${cliCatalog[provider].name}` : null
}

export function resolveInterruptibleInstallTask(
  snapshot: InstallationQueueSnapshot,
): InterruptibleInstallTask | null {
  const keys = snapshot.activeKey ? [snapshot.activeKey, ...snapshot.pendingKeys] : [...snapshot.pendingKeys]
  let first: InterruptibleInstallTask | null = null
  let count = 0
  for (const key of keys) {
    const description = describeInstallTask(key)
    if (!description) continue
    count += 1
    // 排在最前面的那个是用户正在盯着的进度条，名字用它的。
    if (!first) first = { key, description, count }
  }
  return first ? { ...first, count } : null
}

/**
 * 重启装更新会停下、重开以后又不会自己接着做的事（D10）。聊天、视频剪辑的拼片在界面里跑，由界面报上来；
 * 画布出图在主进程里，宿主自己看。交给服务端在生成的视频不算：重开以后会接着取回来。
 */
export type UnfinishedRestartWork = RendererRestartWork | 'canvas'

// 顺序和单子上那句一样；只列真在跑的那几样。
const unfinishedRestartWorkPhrases: ReadonlyArray<readonly [UnfinishedRestartWork, string]> = [
  ['chat', '对话还在回复或出图'],
  ['video-compose', '视频剪辑还在拼接'],
  ['canvas', '画布还在生成'],
]

export interface UnfinishedRestartWorkPrompt {
  /** 这次点到名的那几样，只用于日志与测试。 */
  kinds: UnfinishedRestartWork[]
  message: string
  detail: string
  /** 0 = 等它做完（这次不装，新版本留着），1 = 仍然重启。 */
  buttons: [string, string]
}

/** 重启装更新前那一问（D10）。一样都没在跑时返回 null，不问。 */
export function buildUnfinishedRestartWorkPrompt(running: Iterable<UnfinishedRestartWork>): UnfinishedRestartWorkPrompt | null {
  const present = new Set(running)
  const listed = unfinishedRestartWorkPhrases.filter(([kind]) => present.has(kind))
  if (listed.length === 0) return null
  const phrases = listed.map(([, phrase]) => phrase)
  const last = phrases[phrases.length - 1]
  const sentence = phrases.length === 1 ? last : `${phrases.slice(0, -1).join('，')}，或者${last}`
  return {
    kinds: listed.map(([kind]) => kind),
    message: '还有任务没做完',
    detail: `${sentence}。现在重启会把它们停下，出到一半的图可能已经扣费。`,
    buttons: ['等它做完', '仍然重启'],
  }
}

export interface UpdateRestartConfirmation {
  installTask(): InterruptibleInstallTask | null
  /** 「还在安装」那一问；true = 仍然退出。 */
  confirmInstall(task: InterruptibleInstallTask): Promise<boolean>
  unfinishedWork(): UnfinishedRestartWorkPrompt | null
  /** 「还有任务没做完」那一问；true = 仍然重启。 */
  confirmWork(prompt: UnfinishedRestartWorkPrompt): Promise<boolean>
  log(event: string, message: string): void
}

/**
 * 更新页「重启并安装」、托盘「重启并安装」、跳框里的「现在安装」都先过这里：true = 照常装。
 * 先问工具在装，再问聊天、视频剪辑、画布在做的事。两问说的是不同的东西会被停下，所以都问；
 * 哪一问点了「继续安装」「等它做完」，这次就不装，新版本留着（已知31、D10）。
 */
export async function confirmUpdateRestart(steps: UpdateRestartConfirmation): Promise<boolean> {
  const task = steps.installTask()
  if (task) {
    steps.log('install.install-in-progress', `重启安装更新前确认：${task.key}`)
    if (!await steps.confirmInstall(task)) {
      steps.log('install.postponed', '还有工具在装，这次不装新版本，新版本留着')
      return false
    }
  }
  const work = steps.unfinishedWork()
  if (!work) return true
  steps.log('install.work-in-progress', `重启安装更新前确认：${work.kinds.join(',')}`)
  if (!await steps.confirmWork(work)) {
    steps.log('install.postponed', '还有任务没做完，这次不装新版本，新版本留着')
    return false
  }
  return true
}

export interface ChatReplyQuitPrompt {
  message: string
  /** 0 = 等它说完（这次不退），1 = 仍然退出。 */
  buttons: [string, string]
}

/**
 * 退出时聊天还在回复那一问（D39）。回复在主进程里请求、在界面里一段段收，进程一关就断了，重开以后
 * 也不会接着说完；已经说出来的那部分出字时隔两秒就存（useChatController.ts），停下的是后面那截。
 * 判断跟重启装更新用同一份（D10 的 'chat'，界面报上来的「对话还在回复或出图」），不另算忙闲。
 */
export function buildChatReplyQuitPrompt(running: Iterable<UnfinishedRestartWork>): ChatReplyQuitPrompt | null {
  for (const kind of running) {
    if (kind === 'chat') return { message: '正在回复，退出会停下这条回复。', buttons: ['等它说完', '仍然退出'] }
  }
  return null
}

/** none = 没有要拦的，接着看下好的更新；quit = 问过了、点了「仍然退出」；cancel = 这次不退。 */
export type QuitInterruptionAnswer = 'none' | 'quit' | 'cancel'

export interface QuitInterruptionConfirmation {
  installTask(): InterruptibleInstallTask | null
  /** 「还在安装」那一问；true = 仍然退出。 */
  confirmInstall(task: InterruptibleInstallTask): Promise<boolean>
  chatReply(): ChatReplyQuitPrompt | null
  /** 「正在回复」那一问；true = 仍然退出。 */
  confirmChatReply(prompt: ChatReplyQuitPrompt): Promise<boolean>
  log(event: string, message: string): void
}

/**
 * 托盘、菜单「退出」和「直接退出」偏好放行前，先问会被打断的事：工具在装（已知31），聊天在回复（D39）。
 * 两问说的是不同的东西会被停下，跟重启装更新一样都问；哪一问点了「继续安装」「等它说完」这次就不退。
 * 问过的人不再接着被问要不要顺手装更新（返回 quit），下好的更新留到下次。
 */
export async function confirmQuitInterruptions(steps: QuitInterruptionConfirmation): Promise<QuitInterruptionAnswer> {
  let asked = false
  const task = steps.installTask()
  if (task) {
    steps.log('quit.install-in-progress', `退出前确认：${task.key}`)
    if (!await steps.confirmInstall(task)) return 'cancel'
    asked = true
  }
  // 安装那一问可能要好几分钟才有人答，回复在不在出字等答完再看。
  const reply = steps.chatReply()
  if (reply) {
    steps.log('quit.chat-replying', '退出前确认：聊天还在回复')
    if (!await steps.confirmChatReply(reply)) return 'cancel'
    asked = true
  }
  return asked ? 'quit' : 'none'
}

export interface InstallableUpdateOnQuit {
  /** 已经下载并校验过的版本号；快照里没有时为 null，文案要能少了它也说得通。 */
  version: string | null
}

/**
 * 退出时值得问一句「顺手装上吗」的，只有「下载并校验完成、且这一份还没安装失败过」
 * 这一种状态。更新器刻意关掉了退出时自动安装（`updater.ts` 的 `autoInstallOnAppQuit
 * = false`），安装必须由用户点头才发生；而 `downloaded` 带着 `error` 说明安装器上一次
 * 已经启动过并失败了，`requestInstall` 不会再跑第二遍，再问一次只会得到一个什么都
 * 不做的「安装并退出」。
 */
export function resolveInstallableUpdateOnQuit(snapshot: UpdateSnapshot): InstallableUpdateOnQuit | null {
  if (snapshot.phase !== 'downloaded' || snapshot.error || snapshot.development) return null
  return { version: snapshot.availableVersion }
}

/**
 * 退出时把下好的更新交给 Mac 的安装器以后，等它给结果：装得上它会自己退出重开，
 * 这里永远等不到；装不上（比如校验没通过）时更新器会把失败记在安装那一步，这时
 * 落定，让退出照常走完。安装看门狗 10 秒报的「没起来」不算：慢一点的 Mac 还在
 * 校验，这时退出就把它掐断了，交给退出流程自己的上限去等。
 */
export function waitForUpdateInstallFailure(updates: { subscribe(listener: (snapshot: UpdateSnapshot) => void): () => void }): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    let unsubscribe: (() => void) | null = null
    unsubscribe = updates.subscribe((snapshot) => {
      if (settled || snapshot.failedStep !== 'install' || !snapshot.error) return
      if (snapshot.error.code === updateInstallLaunchTimeoutCode) return
      settled = true
      unsubscribe?.()
      resolve()
    })
    if (settled) unsubscribe()
  })
}

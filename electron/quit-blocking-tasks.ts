import { cliCatalog, isProviderId } from './catalog'
import type { InstallationQueueSnapshot } from './installation-queue'
import type { UpdateSnapshot } from './updater'

export interface InterruptibleInstallTask {
  /** 队列 key，只用于日志与测试，不面向用户。 */
  key: string
  /** 面向用户的一句话，例如「正在安装 Claude Code」。 */
  description: string
  /** 队列里同类任务的总数，含正在跑的那一个。 */
  count: number
}

const cliInstallPrefix = 'cli:install:'

/**
 * 安装类任务被打断不会留下半成品（I11 的原子替换），但已经下载的几十兆白费，
 * 下次打开首页显示的还是旧版本，用户会以为「更新没成功」。所以只有这一类
 * 值得在退出前拦一下；启动 CLI、打开桌面端、卸载都只是拉起进程或删目录，
 * 被打断没有后果，不该拦住退出。
 */
function describeInstallTask(key: string): string | null {
  if (key === 'runtime:node') return '正在安装 Node.js 运行环境'
  if (key === 'runtime:python') return '正在安装 Python 运行环境'
  if (key === 'desktop:codex:install') return '正在安装 Codex 桌面端'
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

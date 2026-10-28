// 手机遥控 Codex 的组装：设置和凭据放 <userData>/codex-remote（凭据 safeStorage 加密），渠道走主进程的会话 fetch，
// Codex 用客户装好的那一份命令行工具起 app-server。Windows 上星芒以管理员身份运行时不许开：
// 那时 Codex 和它跑的每条命令都会是管理员权限，手机上点一下「同意」就是管理员级操作。
import path from 'node:path'
import { safeStorage } from 'electron'
import { commandEnvironment } from '../command-runner'
import { isCodexCliInstalled, resolveCodexCommand } from '../codex-extensions'
import type { ProviderConfigRoots } from '../codex-home'
import type { AppServerProcess } from '../codex-remote-app-server'
import type { CodexRemoteSnapshot } from '../codex-remote-channel'
import { createRemoteChannelAdapter } from '../codex-remote-channels'
import { spawnCodexAppServer } from '../codex-remote-process'
import { CodexRemoteService } from '../codex-remote-service'
import { CodexRemoteStore } from '../codex-remote-store'
import { inspectProviderConfig } from '../config-files'
import { codexRemoteOffMessage } from '../remote-features'
import type { RuntimeLogStore } from '../runtime-log'
import type { WindowsCliExecutionMode } from '../windows-elevation'

export interface CodexRemoteBootstrapOptions {
  managerDataDirectory: string
  runtimeLog: RuntimeLogStore
  /** 主进程的会话 fetch（走系统代理、交回跳转）。 */
  fetch: typeof fetch
  appVersion: string
  homeDirectory: string
  codexEnv: NodeJS.ProcessEnv
  providerRoots: ProviderConfigRoots
  windowsExecution: { mode: WindowsCliExecutionMode; highIntegrity?: boolean }
  /** 起 Codex 排进安装队列（I11，#1407 P3-3）：装、更新、卸载 Codex 时等它做完再起。 */
  enqueueLaunch(launch: () => Promise<AppServerProcess>): Promise<AppServerProcess>
  onStateChanged(snapshot: CodexRemoteSnapshot): void
  /** 状态文件关掉了手机遥控（remote-features.ts）。它变了要调一次 applyAvailability。缺省 = 不关。 */
  suspended?(): boolean
}

const elevatedMessage = '星芒正以管理员身份运行。为了安全，这时不能打开手机遥控，请用普通方式重新打开星芒。'
const unconfirmedMessage = '没能确认星芒是不是以管理员身份运行。为了安全，这时不能打开手机遥控，请用普通方式重新打开星芒再试。'

/**
 * Windows 上只有确认是普通权限才许开：same-user，并且读出了完整性标签、低于高完整性（#1407 P2-5）。
 * 标签读不出来时 highIntegrity 是缺省，这时的 same-user 确认不了不是管理员：令牌类型 default 也包括自带
 * Administrator、关了 UAC 的电脑；两步都探测失败时是按普通用户兜底（windows-elevation 2026-09-23 的产品决定，
 * 为了让命令行工具照常能装能开），遥控不跟着放行。
 */
export function resolveCodexRemoteAvailability(
  platform: NodeJS.Platform,
  execution: { mode: WindowsCliExecutionMode; highIntegrity?: boolean },
): string | null {
  if (platform !== 'win32') return null
  if (execution.mode !== 'same-user' || execution.highIntegrity === true) return elevatedMessage
  return execution.highIntegrity === false ? null : unconfirmedMessage
}

export function createCodexRemote(options: CodexRemoteBootstrapOptions): CodexRemoteService {
  const env = commandEnvironment(options.codexEnv)
  const store = new CodexRemoteStore(path.join(options.managerDataDirectory, 'codex-remote'), safeStorage)
  return new CodexRemoteService({
    store,
    createChannel: createRemoteChannelAdapter,
    fetch: options.fetch,
    appVersion: options.appVersion,
    homeDirectory: options.homeDirectory,
    log: (level, event, detail) => options.runtimeLog.log(level, 'codex-remote', event, `手机遥控：${event}`, detail),
    spawnCodex: () => options.enqueueLaunch(() => spawnCodexAppServer({
      env,
      // 只在普通权限下才会走到这里（resolveCodexRemoteAvailability），所以按 same-user 认 Codex。
      resolveCommand: () => resolveCodexCommand(env, undefined, undefined, 'same-user'),
    })),
    readCodexSecrets: async () => {
      const key = inspectProviderConfig('codex', options.providerRoots).apiKey.trim()
      return key ? [key] : []
    },
    // 管理员身份那句在前：那句告诉他自己能怎么办。
    inspectAvailability: () => resolveCodexRemoteAvailability(process.platform, options.windowsExecution)
      ?? (options.suspended?.() ? codexRemoteOffMessage : null),
    checkCodexReady: async () => (await isCodexCliInstalled(options.codexEnv)
      ? null
      : '这台电脑还没装 Codex 命令行工具，先在首页把它装好。'),
    onStateChanged: options.onStateChanged,
  })
}

// 手机遥控 Codex 的组装：设置和凭据放 <userData>/codex-remote（凭据 safeStorage 加密），渠道走主进程的会话 fetch，
// Codex 用客户装好的那一份命令行工具起 app-server。Windows 上星芒以管理员身份运行时不许开：
// 那时 Codex 和它跑的每条命令都会是管理员权限，手机上点一下「同意」就是管理员级操作。
import path from 'node:path'
import { safeStorage } from 'electron'
import { commandEnvironment } from '../command-runner'
import { isCodexCliInstalled, resolveCodexCommand } from '../codex-extensions'
import type { ProviderConfigRoots } from '../codex-home'
import type { CodexRemoteSnapshot } from '../codex-remote-channel'
import { createRemoteChannelAdapter } from '../codex-remote-channels'
import { spawnCodexAppServer } from '../codex-remote-process'
import { CodexRemoteService } from '../codex-remote-service'
import { CodexRemoteStore } from '../codex-remote-store'
import { inspectProviderConfig } from '../config-files'
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
  onStateChanged(snapshot: CodexRemoteSnapshot): void
}

const elevatedMessage = '星芒正以管理员身份运行。为了安全，这时不能打开手机遥控，请用普通方式重新打开星芒。'

/** Windows 上只有确认是普通权限（same-user 且不是高完整性）才许开。 */
export function resolveCodexRemoteAvailability(
  platform: NodeJS.Platform,
  execution: { mode: WindowsCliExecutionMode; highIntegrity?: boolean },
): string | null {
  if (platform !== 'win32') return null
  return execution.mode === 'same-user' && execution.highIntegrity !== true ? null : elevatedMessage
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
    spawnCodex: () => spawnCodexAppServer({
      env,
      // 只在普通权限下才会走到这里（resolveCodexRemoteAvailability），所以按 same-user 认 Codex。
      resolveCommand: () => resolveCodexCommand(env, undefined, undefined, 'same-user'),
    }),
    readCodexSecrets: async () => {
      const key = inspectProviderConfig('codex', options.providerRoots).apiKey.trim()
      return key ? [key] : []
    },
    inspectAvailability: () => resolveCodexRemoteAvailability(process.platform, options.windowsExecution),
    checkCodexReady: async () => (await isCodexCliInstalled(options.codexEnv)
      ? null
      : '这台电脑还没装 Codex 命令行工具，先在首页把它装好。'),
    onStateChanged: options.onStateChanged,
  })
}

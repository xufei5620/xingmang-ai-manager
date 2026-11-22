// 手机遥控 Codex 的组装：设置和凭据放 <userData>/codex-remote（凭据 safeStorage 加密），手机上发来的图暂放
// 它下面的 images（YF-14，交给 Codex 以后删），渠道走主进程的会话 fetch，
// Codex 用客户装好的那一份命令行工具起 app-server。Windows 上右键「以管理员身份运行」打开星芒时不许开：
// 那时 Codex 和它跑的每条命令都会是管理员权限，手机上点一下「同意」就是管理员级操作。登录账号本身
// 就带管理员权限的电脑（自带 Administrator、关了授权弹窗）许开，见 resolveCodexRemoteAvailability。
import path from 'node:path'
import { safeStorage } from 'electron'
import { commandEnvironment } from '../command-runner'
import { isCodexCliInstalled, resolveCodexCommand } from '../codex-extensions'
import type { ProviderConfigRoots } from '../codex-home'
import type { AppServerProcess } from '../codex-remote-app-server'
import type { CodexRemoteSnapshot } from '../codex-remote-channel'
import { createRemoteChannelAdapter } from '../codex-remote-channels'
import { createRemoteImageStore } from '../codex-remote-images'
import { spawnCodexAppServer } from '../codex-remote-process'
import { CodexRemoteService } from '../codex-remote-service'
import { CodexRemoteStore } from '../codex-remote-store'
import { inspectProviderConfig } from '../config-files'
import { codexRemoteOffMessage } from '../remote-features'
import type { RuntimeLogStore } from '../runtime-log'
import type { WindowsCliExecutionMode, WindowsExecutionProbeFailure } from '../windows-elevation'

/** 启动时那次权限探测的结论（windows-elevation 的 resolveWindowsCliExecutionModeDetailed）。 */
export interface CodexRemoteWindowsExecution {
  mode: WindowsCliExecutionMode
  highIntegrity?: boolean
  probeFailure?: WindowsExecutionProbeFailure
}

export interface CodexRemoteBootstrapOptions {
  managerDataDirectory: string
  runtimeLog: RuntimeLogStore
  /** 主进程的会话 fetch（走系统代理、交回跳转）。 */
  fetch: typeof fetch
  appVersion: string
  homeDirectory: string
  codexEnv: NodeJS.ProcessEnv
  providerRoots: ProviderConfigRoots
  windowsExecution: CodexRemoteWindowsExecution
  /** 起 Codex 排进安装队列（I11，#1407 P3-3）：装、更新、卸载 Codex 时等它做完再起。 */
  enqueueLaunch(launch: () => Promise<AppServerProcess>): Promise<AppServerProcess>
  onStateChanged(snapshot: CodexRemoteSnapshot): void
  /** 状态文件关掉了手机遥控（remote-features.ts）。它变了要调一次 applyAvailability。缺省 = 不关。 */
  suspended?(): boolean
  /** 手机上发「状态」时报的余额（美元，YF-18）；没登录、读不到回 null。 */
  readBalanceUsd?(): Promise<number | null>
}

const elevatedMessage = '星芒正以管理员身份运行，为保障安全，此时无法开启手机遥控。请以普通方式重新打开星芒。'
const unconfirmedMessage = '无法确认星芒是否以管理员身份运行，为保障安全，此时无法开启手机遥控。请以普通方式重新打开星芒后重试。'

/**
 * Whether this Windows account runs every program at High integrity by itself: the
 * built-in Administrator without Admin Approval Mode, or any administrator on a
 * machine with UAC turned off. The startup probe proved the token is High yet not
 * an elevated half of a split token (TokenElevationType default), so no
 * "run as administrator" step was taken to get here.
 *
 * Remote control is allowed on such an account (yoyo typed his consent on
 * 2026-11-20). There is no elevation boundary to protect on it: whatever the
 * account starts, from a terminal or from this app's own "open tool", already runs
 * as administrator, so Codex started for the phone gets nothing beyond the
 * account's normal context. Telling these customers to "reopen normally" could
 * never work. What stays blocked is the boundary a customer crosses by choice
 * (trusted-only) and every case the probe could not settle.
 */
export function isAlwaysElevatedWindowsAccount(
  platform: NodeJS.Platform,
  execution: CodexRemoteWindowsExecution,
): boolean {
  return platform === 'win32'
    && execution.mode === 'same-user'
    && execution.highIntegrity === true
    && execution.probeFailure === undefined
}

/**
 * Windows 上只有探测说得清的两种许开（#1407 P2-5）：same-user 且读出了完整性标签、低于高完整性的普通权限；
 * 以及账号本身就带管理员权限的那种（isAlwaysElevatedWindowsAccount）。右键「以管理员身份运行」（trusted-only）
 * 照旧不许。标签读不出来时 highIntegrity 是缺省，这时的 same-user 确认不了是哪一种：两步都探测失败时是按
 * 普通用户兜底（windows-elevation 2026-09-23 的产品决定，为了让命令行工具照常能装能开），遥控不跟着放行。
 */
export function resolveCodexRemoteAvailability(
  platform: NodeJS.Platform,
  execution: CodexRemoteWindowsExecution,
): string | null {
  if (platform !== 'win32') return null
  if (execution.mode !== 'same-user') return elevatedMessage
  if (execution.highIntegrity === false || isAlwaysElevatedWindowsAccount(platform, execution)) return null
  return unconfirmedMessage
}

export function createCodexRemote(options: CodexRemoteBootstrapOptions): CodexRemoteService {
  const env = commandEnvironment(options.codexEnv)
  const directory = path.join(options.managerDataDirectory, 'codex-remote')
  const store = new CodexRemoteStore(directory, safeStorage)
  return new CodexRemoteService({
    store,
    imageStore: createRemoteImageStore(path.join(directory, 'images')),
    createChannel: createRemoteChannelAdapter,
    fetch: options.fetch,
    appVersion: options.appVersion,
    homeDirectory: options.homeDirectory,
    log: (level, event, detail) => options.runtimeLog.log(level, 'codex-remote', event, `手机遥控：${event}`, detail),
    spawnCodex: () => options.enqueueLaunch(() => spawnCodexAppServer({
      env,
      // 只在 same-user 下才会走到这里（resolveCodexRemoteAvailability，含账号本身就带管理员权限的那种，
      // 那种账号上星芒打开工具本来就按 same-user），所以按 same-user 认 Codex。
      resolveCommand: () => resolveCodexCommand(env, undefined, undefined, 'same-user'),
    })),
    readCodexSecrets: async () => {
      const key = inspectProviderConfig('codex', options.providerRoots).apiKey.trim()
      return key ? [key] : []
    },
    // 管理员身份那句在前：那句告诉他自己能怎么办。
    inspectAvailability: () => resolveCodexRemoteAvailability(process.platform, options.windowsExecution)
      ?? (options.suspended?.() ? codexRemoteOffMessage : null),
    alwaysElevatedAccount: isAlwaysElevatedWindowsAccount(process.platform, options.windowsExecution),
    checkCodexReady: async () => (await isCodexCliInstalled(options.codexEnv)
      ? null
      : '本机尚未安装 Codex CLI，请先在首页完成安装。'),
    onStateChanged: options.onStateChanged,
    ...(options.readBalanceUsd ? { readBalanceUsd: options.readBalanceUsd } : {}),
  })
}

// @renderer-importable: bundled into the renderer, so no Node or Electron here or in what it value-imports (I6).
import type { ActiveProviderId } from './catalog'
import type { ExternalToolId } from './external-tool-config'

/**
 * 远程开关的第二批（商业级差距 G04，在线热更新方案路线 A）：状态文件的 featuresOff 里写上某个功能，
 * 认这一项的客户端就把它关掉，不用发版。第一批是已知问题提示和充值方式开关（service-status.ts）。
 *
 * 只能关、不能开：名单写死在这里，状态文件只能从里面挑几样关掉，挑不出程序里没有的东西，也打不开
 * 任何本来没开的能力（这份文件没有签名，被人改了最坏也只是关掉几样功能）。要加一样能关的，先发一版。
 *
 * 零依赖：渲染层照这里的说法认出「这个功能暂时停用了」（operation-error.ts），主进程照这里拼话。
 */
export const remoteFeatureTools = ['claude', 'codex', 'grok', 'codexDesktop', 'claudeDesktop', 'workbuddy', 'opencode'] as const satisfies readonly (ActiveProviderId | 'codexDesktop' | ExternalToolId)[]
export type RemoteFeatureTool = typeof remoteFeatureTools[number]

/**
 * - video-studio：视频剪辑页（写分镜、出片段）。已经交出去的片段照常取回，那是付过钱的。
 * - codex-remote：手机遥控 Codex。开着的渠道当场停掉。
 * - mac-idle-install：Mac 上趁电脑闲着自己装更新（update-install-prompt.ts）。退出时、下次打开时照常装。
 * - tray-release：缩到托盘久了关掉界面省内存（renderer-release.ts）。
 * - acceleration：网络加速的新连接（加速页、托盘、打开桌面端时替他连的那次）。连着的照常用、照常能断。
 * - codex-desktop-chinese：打开 Codex 桌面端时的中文补丁（Windows 上经调试端口打的那个）。
 * - install:工具 / launch:工具：某个工具的安装和更新、从星芒打开它。
 */
export const remoteFeatureIds = [
  'video-studio',
  'codex-remote',
  'mac-idle-install',
  'tray-release',
  'acceleration',
  'codex-desktop-chinese',
  ...remoteFeatureTools.map((tool) => `install:${tool}` as const),
  ...remoteFeatureTools.map((tool) => `launch:${tool}` as const),
] as const

export type RemoteFeatureId = typeof remoteFeatureIds[number]

/** 状态文件里写的名字认成哪一样：不分大小写（install:codexdesktop 也算），认不出给 null。 */
export function resolveRemoteFeatureId(value: unknown): RemoteFeatureId | null {
  const name = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return remoteFeatureIds.find((id) => id.toLowerCase() === name) ?? null
}

/** 每句停用的话都带着这半句：渲染层靠它认出是开关关的，不是真出了错（operation-error.ts）。 */
export const remoteFeatureOffMarker = '修好以后会自动恢复'

// Electron 只把 `${name}: ${message}` 交过 IPC，名字是唯一原样过去的字段（external-url-blocked.ts 同理）；
// 渲染层的 rawErrorMessage 会把它剥掉，上屏的只有那句话。
export const remoteFeatureOffErrorName = 'RemoteFeatureOffError'

export class RemoteFeatureOffError extends Error {
  constructor(message: string) {
    super(message)
    this.name = remoteFeatureOffErrorName
  }
}

export function isRemoteFeatureOffMessage(message: string): boolean {
  return message.includes(remoteFeatureOffMarker)
}

// 名字以字母、数字结尾时跟「的」之间空一格：Codex CLI 的、Codex 桌面端的。
function possessive(name: string): string {
  return /[A-Za-z0-9]$/.test(name) ? `${name} 的` : `${name}的`
}

// 客户看得到的这几句是 yoyo 2026-10-28 回「停用改」批的，改字要先问他。
export const videoStudioOffMessage = `视频剪辑暂时停用了，${remoteFeatureOffMarker}。`
export const codexRemoteOffMessage = `手机遥控暂时停用了，${remoteFeatureOffMarker}。`
export const accelerationOffMessage = `网络加速暂时停用了，${remoteFeatureOffMarker}。`
export const codexDesktopChineseOffMessage = `Codex 已经打开，中文界面暂时停用了，这次先用英文界面，${remoteFeatureOffMarker}。`

export function toolInstallOffMessage(toolName: string): string {
  return `${possessive(toolName)}安装和更新暂时停用了，${remoteFeatureOffMarker}。`
}

export function toolLaunchOffMessage(toolName: string): string {
  return `暂时不能从星芒打开 ${toolName}，${remoteFeatureOffMarker}。`
}

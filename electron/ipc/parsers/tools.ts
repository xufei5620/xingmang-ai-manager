// 命令行工具和 Codex 桌面端的安装、卸载、配置、启动，以及选工作目录的入参。
import { activeProviderIds, isActiveProviderId, type ProviderId } from '../../catalog'
import type { CodexDesktopLocale } from '../../codex-desktop-locale'
import type { NativeConfigSaveMode } from '../../config-files'
import { isRecord } from '../../input-guards'
import { pastedApiKeyFormatMessage } from '../../pasted-api-key'
import type { ChooseWorkspaceOptions } from '../../ipc-contract'
import type { CliLaunchMode, CliUninstallOptions, CodexDesktopLaunchMode, ConfigSavePayload } from '../../system-service'
import { isCliSessionUuid } from '../../tool-installation'
import { isExactCliVersion } from '../../versions'
import { requiredWorkspacePath } from './common'

export function parseCliUninstallOptions(value: unknown): CliUninstallOptions {
  if (value === undefined) return {}
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'reinstall')
    || (value.reinstall !== undefined && typeof value.reinstall !== 'boolean')) throw new Error('卸载参数格式错误')
  return value.reinstall === true ? { reinstall: true } : {}
}

export function parseConfigSavePayload(payload: unknown): ConfigSavePayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('配置请求格式错误')
  }
  const input = payload as {
    provider?: unknown
    apiKey?: unknown
    model?: unknown
    mode?: unknown
  }
  if (!isActiveProviderId(input.provider)) throw new Error('未知的 CLI 类型')
  if (typeof input.apiKey !== 'string' || input.apiKey.length > 4_096) {
    throw new Error(pastedApiKeyFormatMessage)
  }
  if (typeof input.model !== 'string' || input.model.length > 256) {
    throw new Error('模型格式错误')
  }
  if (input.mode !== 'merge' && input.mode !== 'reset') {
    throw new Error('配置保存方式错误')
  }
  return {
    provider: input.provider,
    apiKey: input.apiKey,
    model: input.model,
    mode: input.mode as NativeConfigSaveMode,
  }
}

export function parseChooseWorkspaceOptions(value: unknown): ChooseWorkspaceOptions {
  if (value === undefined) return {}
  if (!isRecord(value)) throw new Error('选择项目文件夹的参数无效')
  const keys = Object.keys(value)
  if (keys.some((key) => key !== 'createStarter' && key !== 'firstOpen')) throw new Error('选择项目文件夹的参数无效')
  if (value.createStarter !== undefined && typeof value.createStarter !== 'boolean') throw new Error('选择项目文件夹的参数无效')
  if (value.firstOpen !== undefined && typeof value.firstOpen !== 'boolean') throw new Error('选择项目文件夹的参数无效')
  return {
    ...(value.createStarter === undefined ? {} : { createStarter: value.createStarter }),
    ...(value.firstOpen === undefined ? {} : { firstOpen: value.firstOpen }),
  }
}

// 没带目录（或只带了空白）时用记住的那个，它也得是完整路径：设置文件被改坏、或者以前经 settings:save
// 存进去一个相对路径，同样会让「这个文件夹不建议打开」那一问认不出来。带了但不是字符串的直接报错，
// 不悄悄换成记住的目录——那只会是界面出了 bug 或被人动过。
export function parseWorkspace(workspace: unknown, fallback: string, platform: NodeJS.Platform): string {
  if (workspace !== undefined && typeof workspace !== 'string') throw new Error('项目文件夹路径格式错误')
  return requiredWorkspacePath(workspace?.trim() ? workspace : fallback, platform)
}

export function parseDesktopLaunchMode(mode: unknown): CodexDesktopLaunchMode {
  if (mode !== 'open' && mode !== 'restart') throw new Error('Codex 桌面端启动方式错误')
  return mode
}

// 渲染层只能在这两个值之间选,续接参数由主进程按工具固定生成,任何字符串都
// 不会透传进 argv(I5)。省略 = 开新对话,与加这个参数之前完全一致。
export function parseCliLaunchMode(mode: unknown): CliLaunchMode {
  if (mode === undefined || mode === null) return 'new'
  if (mode !== 'new' && mode !== 'resumeLast') throw new Error('CLI 启动方式错误')
  return mode
}

// 第四个参数只收记录页 / 首页那条记录自己的 id:Codex 是 `codex:<UUID>`,Claude Code、
// Grok CLI 是 `claude:` / `grok:` 加 64 位十六进制(记录文件位置的哈希,见 provider-sessions.ts
// 的 stableSessionId)。别的启动方式带了它、或者带的是另一家的记录都算错。id 只拿来在主进程
// 自己读出的记录里查找,查到后交给 argv 的是从记录里取出、再校验过形状的 UUID,渲染层的
// 字符串不会原样进命令行(I5)。
export function parseResumeRecordId(provider: ProviderId, mode: CliLaunchMode, recordId: unknown): string | null {
  if (recordId === undefined || recordId === null) return null
  if (mode !== 'resumeLast') throw new Error('CLI 启动方式错误')
  if (typeof recordId !== 'string') throw new Error('会话 ID 格式错误')
  const owner = resumeRecordOwner(recordId)
  if (owner === null) throw new Error('会话 ID 格式错误')
  if (owner !== provider) throw new Error('CLI 启动方式错误')
  return recordId
}

const externalRecordHashPattern = /^[0-9a-f]{64}$/

// 形状对得上哪一家的记录 id 就是哪一家的;哪家都不像给 null。
function resumeRecordOwner(recordId: string): ProviderId | null {
  const separator = recordId.indexOf(':')
  if (separator < 0) return null
  const prefix = recordId.slice(0, separator)
  const rest = recordId.slice(separator + 1)
  if (prefix === 'codex') return isCliSessionUuid(rest) ? 'codex' : null
  if (prefix === 'claude' || prefix === 'grok') return externalRecordHashPattern.test(rest) ? prefix : null
  return null
}

export function parseCodexDesktopLocale(locale: unknown): CodexDesktopLocale {
  if (locale !== 'zh-CN' && locale !== 'system') throw new Error('Codex Desktop 语言选项错误')
  return locale
}

// 更新和回退都提交精确版本，使用与 registry 读取一致的校验：
// 'latest'、范围表达式(^1.2.3)和 dist-tag 全部拒绝,它们会让 npm 自己去
// 决定装什么,绕过名单(I5:IPC 入参一律视为敌意输入)。
export function parseCliInstallVersion(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (!isExactCliVersion(value)) {
    throw new Error('CLI 版本号格式错误')
  }
  return value
}

/** 只收已知工具，去重；一次问的个数不超过工具总数（I5）。 */
export function parseRunningToolsProviders(value: unknown): ProviderId[] {
  if (!Array.isArray(value) || value.length > activeProviderIds.length) throw new Error('工具列表格式错误')
  const providers: ProviderId[] = []
  for (const item of value) {
    if (!isActiveProviderId(item)) throw new Error('未知的 CLI 类型')
    if (!providers.includes(item)) providers.push(item)
  }
  return providers
}

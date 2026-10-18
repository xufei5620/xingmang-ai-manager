// 命令行工具和 Codex 桌面端的安装、卸载、配置、启动，以及选工作目录的入参。
import { activeProviderIds, isActiveProviderId, type ProviderId } from '../../catalog'
import type { CodexDesktopLocale } from '../../codex-desktop-locale'
import type { NativeConfigSaveMode } from '../../config-files'
import { isRecord } from '../../input-guards'
import type { ChooseWorkspaceOptions } from '../../ipc-contract'
import type { CliLaunchMode, CliUninstallOptions, CodexDesktopLaunchMode, ConfigSavePayload } from '../../system-service'
import { isCodexSessionUuid } from '../../tool-installation'
import { isExactCliVersion } from '../../versions'

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
    throw new Error('API Key 格式错误')
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
  if (!isRecord(value)) throw new Error('选择工作目录的参数无效')
  const keys = Object.keys(value)
  if (keys.some((key) => key !== 'createStarter' && key !== 'firstOpen')) throw new Error('选择工作目录的参数无效')
  if (value.createStarter !== undefined && typeof value.createStarter !== 'boolean') throw new Error('选择工作目录的参数无效')
  if (value.firstOpen !== undefined && typeof value.firstOpen !== 'boolean') throw new Error('选择工作目录的参数无效')
  return {
    ...(value.createStarter === undefined ? {} : { createStarter: value.createStarter }),
    ...(value.firstOpen === undefined ? {} : { firstOpen: value.firstOpen }),
  }
}

export function parseWorkspace(workspace: unknown, fallback: string): string {
  if (typeof workspace === 'string' && workspace.length > 32_767) {
    throw new Error('工作目录格式错误')
  }
  return typeof workspace === 'string' && workspace.trim() ? workspace.trim() : fallback
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

// 第四个参数只收 Codex 记录页 / 首页那条记录自己的 id(`codex:<UUID>`),别的工具、
// 别的启动方式带了它都算错。id 只拿来在主进程自己读出的 Codex 记录里查找,查到后
// 交给 argv 的也是重新校验过形状的 UUID,渲染层的字符串不会原样进命令行(I5)。
export function parseCodexResumeRecordId(provider: ProviderId, mode: CliLaunchMode, recordId: unknown): string | null {
  if (recordId === undefined || recordId === null) return null
  if (provider !== 'codex' || mode !== 'resumeLast') throw new Error('CLI 启动方式错误')
  if (typeof recordId !== 'string' || !recordId.startsWith('codex:') || !isCodexSessionUuid(recordId.slice('codex:'.length))) {
    throw new Error('会话 ID 格式错误')
  }
  return recordId
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

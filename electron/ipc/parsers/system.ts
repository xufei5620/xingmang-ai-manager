// 窗口、诊断、更新、检测、Node.js 安装和渲染层报错这几条通道的入参。
import type { DiagnosticsRunOptions } from '../../diagnostics'
import type { ExternalClientScanOptions } from '../../external-client-contract'
import { isRecord } from '../../input-guards'
import type { AppUninstallRequest, NodeRuntimeInstallRequest, RendererLogLevel, UpdateInstallOptions } from '../../ipc-contract'
import type { SystemScanOptions } from '../../system-service'
import type { UpdateDownloadOptions } from '../../updater'
import { optionalBoolean, optionalString, requiredString } from './common'

export function parseAppUninstallRequest(value: unknown): AppUninstallRequest {
  if (!isRecord(value)) throw new Error('卸载选项格式错误')
  return {
    clearLoginRecords: optionalBoolean(value.clearLoginRecords, '卸载选项') ?? false,
    removeManagedTools: optionalBoolean(value.removeManagedTools, '卸载选项') ?? false,
  }
}

export function parseDiagnosticsRunOptions(value: unknown): DiagnosticsRunOptions {
  if (value === undefined) return {}
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'reuseRecentScan')
    || (value.reuseRecentScan !== undefined && typeof value.reuseRecentScan !== 'boolean')) throw new Error('诊断参数格式错误')
  return value.reuseRecentScan === true ? { reuseRecentScan: true } : {}
}

export function parseUpdateDownloadOptions(value: unknown): UpdateDownloadOptions {
  if (value === undefined) return {}
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'ignoreDiskSpace')
    || (value.ignoreDiskSpace !== undefined && typeof value.ignoreDiskSpace !== 'boolean')) throw new Error('下载参数格式错误')
  return value.ignoreDiskSpace === true ? { ignoreDiskSpace: true } : {}
}

export function parseUpdateInstallOptions(value: unknown): UpdateInstallOptions {
  if (value === undefined) return {}
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'askIfInstalling')
    || (value.askIfInstalling !== undefined && typeof value.askIfInstalling !== 'boolean')) throw new Error('安装参数格式错误')
  return value.askIfInstalling === true ? { askIfInstalling: true } : {}
}

export function parseSystemScanOptions(value: unknown): SystemScanOptions {
  if (value === undefined) return {}
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'acceptCached' && key !== 'recheckRoutes')
    || (value.acceptCached !== undefined && typeof value.acceptCached !== 'boolean')
    || (value.recheckRoutes !== undefined && typeof value.recheckRoutes !== 'boolean')) throw new Error('检测参数格式错误')
  return { ...(value.acceptCached === true ? { acceptCached: true } : {}), ...(value.recheckRoutes === true ? { recheckRoutes: true } : {}) }
}

export function parseExternalClientScanOptions(value: unknown): ExternalClientScanOptions {
  if (value === undefined) return {}
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'cachedOnly')
    || (value.cachedOnly !== undefined && typeof value.cachedOnly !== 'boolean')) throw new Error('客户端检测参数格式错误')
  return value.cachedOnly === true ? { cachedOnly: true } : {}
}

export function parseNodeRuntimeInstallRequest(value: unknown): NodeRuntimeInstallRequest {
  if (value === undefined) return {}
  if (!isRecord(value)) throw new Error('安装 Node.js 的参数无效')
  if (Object.keys(value).some((key) => key !== 'reason')) throw new Error('安装 Node.js 的参数无效')
  if (value.reason === undefined) return {}
  if (value.reason !== 'certificate') throw new Error('安装 Node.js 的参数无效')
  return { reason: 'certificate' }
}

export function parseRendererLogLevel(value: unknown): RendererLogLevel {
  if (value === undefined) return 'error'
  if (value === 'info' || value === 'warn' || value === 'error') return value
  throw new Error('日志级别无效')
}

export function parseRendererError(value: unknown): { message: string; stack?: string; context?: string; level: RendererLogLevel } {
  if (!isRecord(value)) throw new Error('渲染进程错误格式无效')
  return {
    message: requiredString(value.message, '错误消息', 4_096),
    stack: optionalString(value.stack, '错误堆栈', 16_384),
    context: optionalString(value.context, '错误上下文', 256),
    level: parseRendererLogLevel(value.level),
  }
}

import type { ProviderId } from './catalog'
import type { ExternalToolId } from './external-tool-config'

export interface ExternalClientRuntimeStatus {
  tool: ExternalToolId
  installed: boolean
  version: string | null
  path: string | null
  installDirectory: string | null
  running: boolean
  installSupported: boolean
  launchSupported: boolean
  detectionError: string | null
  installHint: string | null
}

export interface ExternalClientConnectionStatus {
  /** Valid configuration explicitly associated with the current toolbox account. */
  configured: boolean
  /** Local configuration is complete; does not verify account ownership or live requests. */
  configurationReady?: boolean
  model: string | null
  configurationSource: 'xingmang' | 'other' | 'missing' | 'unknown'
  configurationError: string | null
}

export interface ExternalClientStatus extends ExternalClientRuntimeStatus, ExternalClientConnectionStatus {}

export function isExternalToolId(value: unknown): value is ExternalToolId {
  return value === 'workbuddy' || value === 'claudeDesktop' || value === 'opencode'
}

export interface ExternalClientInstallProgress {
  tool: ExternalToolId
  phase: 'queued' | 'checking' | 'downloading' | 'installing' | 'completed' | 'error'
  message: string
  percent: number | null
}

export type ExternalClientCredential =
  | { kind: 'configured'; provider: ProviderId }
  | { kind: 'account'; keyId: number }
  | { kind: 'manual'; apiKey: string }

export interface ExternalClientConfigRequest {
  credential: ExternalClientCredential
  model: string
  protocol?: 'responses' | 'chat-completions'
}

export interface ExternalClientConfigResult {
  tool: ExternalToolId
  model: string
  path: string
  files: string[]
  backups: string[]
  outcome: 'configured'
  message: string
  restartRequired: boolean
  connectionVerified: false
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('客户端配置参数无效')
  return value as Record<string, unknown>
}

function text(value: unknown, label: string, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${label}格式无效`)
  }
  return value.trim()
}

export function parseExternalClientConfigRequest(input: unknown): ExternalClientConfigRequest {
  const value = record(input)
  const source = record(value.credential)
  let credential: ExternalClientCredential
  if (source.kind === 'configured') {
    if (source.provider !== 'claude' && source.provider !== 'codex' && source.provider !== 'gemini' && source.provider !== 'grok') {
      throw new Error('密钥来源无效')
    }
    credential = { kind: 'configured', provider: source.provider }
  } else if (source.kind === 'account') {
    if (typeof source.keyId !== 'number' || !Number.isSafeInteger(source.keyId) || source.keyId <= 0) throw new Error('密钥 ID 无效')
    credential = { kind: 'account', keyId: source.keyId }
  } else if (source.kind === 'manual') {
    credential = { kind: 'manual', apiKey: text(source.apiKey, '访问密钥', 4096) }
  } else throw new Error('请选择密钥来源')
  if (value.protocol !== undefined && value.protocol !== 'responses' && value.protocol !== 'chat-completions') throw new Error('客户端接口类型无效')
  return { credential, model: text(value.model, '模型名称', 256), ...(value.protocol ? { protocol: value.protocol } : {}) }
}

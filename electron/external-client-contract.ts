import type { ProviderId } from './catalog'
import type { ExternalClientCheckResult } from './external-client-connection'
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

/**
 * 展示与遍历顺序。首页、反馈报告与检查页都按这一份走，各处不再自写字面量数组
 * （同 registry/tools.ts 收口展示顺序的理由，AGENTS.md T2）。
 */
export const externalToolIds: readonly ExternalToolId[] = ['workbuddy', 'claudeDesktop', 'opencode']

/**
 * 客户端显示名，只用来拼主进程给出的中文结论。渲染层 registry/clients.ts 另有
 * 一份有意重复的字面量：那份是界面上的展示，这份进的是自检与反馈报告的文字，
 * 两边不互相 import（同 connectionLayerLabels 的理由，I6）。
 */
export const externalClientNames: Readonly<Record<ExternalToolId, string>> = {
  workbuddy: 'WorkBuddy',
  claudeDesktop: 'Claude Desktop',
  opencode: 'OpenCode',
}

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
  /**
   * 保存之后那一次自检的结论。0.2.6~0.2.8 这里恒为 false、成功文案里写着
   * 「未验证实际模型调用」——用户看到「已配好」却在客户端里得不到回话时，
   * 本机没有任何线索可查。现在保存完会把配置回读一遍再用它里面的密钥核对
   * 一次当前账号的模型清单，通不过就在同一张 Notice 上说明卡在哪一层。
   */
  connectionVerified: boolean
  /** 自检结果本身；客户端没装或配置回读不出来时为 null。永不含 Key。 */
  connection: ExternalClientCheckResult | null
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

import type {
  AccountKey,
  AppConfigSummary,
  ExternalClientConfigRequest,
  ExternalClientCredential,
  ExternalClientStatus,
  ExternalToolId,
  RendererLogLevel,
  XingmangApi,
} from '../../../../electron/ipc-contract'
import { clientConnections, clientKeySources } from '../../registry/clients'
import { errorMessage } from '../../business-common'
import { connectionCheckView } from './connection-check'
import { configuredSourceModel, detectedClientModel, initialClientSource } from './external-client-defaults'
import { readAllAccountKeys } from './key-selection'

// 决定单 D7（yoyo 2026-11-11「决定单照推荐」）：Claude Desktop、WorkBuddy、OpenCode 装好或登录以后，从没配置过、
// 默认密钥和型号也定得下来的，替客户自动连一次，省掉「确认连接」→「保存并检测」那两下。挑密钥、挑型号跟
// 配置窗口打开时替他挑的是同一套（external-client-defaults.ts），挑不准就不连，照旧等他自己点。

export type ExternalAutoConnectBridge = Pick<XingmangApi, 'getConfig' | 'getAccountKeys' | 'listConfiguredModels' | 'listAccountKeyModels' | 'configureExternalTool'>

export type ExternalAutoConnectTrigger = 'install' | 'login'

export type ExternalAutoConnectOutcome =
  | { kind: 'skipped'; reason: 'no-key' | 'no-model' | 'account-changed' }
  | { kind: 'connected'; model: string; verified: boolean }
  | { kind: 'failed'; message: string }

export interface ExternalAutoConnectChoice {
  credential: Extract<ExternalClientCredential, { kind: 'configured' | 'account' }>
  /** 配置窗口打开时替他填的那个型号；用账号里的密钥时是空的，列完型号再挑。 */
  model: string
}

/**
 * 这一家值不值得自动连：只认主进程这一刻现看的「从没配置过」（pristine，开机先摆出来的上次结果不算）。
 * 开着的不碰，同换线路、换 Key 一样等它退出；检测出错、配置读不了的也不碰。
 */
export function externalAutoConnectEligible(status: ExternalClientStatus): boolean {
  return status.installed && status.pristine === true && !status.running && !status.cachedAt
    && !status.detectionError && !status.configurationError && status.configurationSource === 'missing'
}

/**
 * 用哪把密钥、先填哪个型号：跟配置窗口打开时默认选的一样。挑出来的是要客户自己填的密钥就是 null。
 * OpenCode 还有一项「模型类型」，只有借 Codex 那把时默认的「Codex / GPT 系列模型」才拿得准
 * （docs/EXTERNAL-CLIENT-CONFIG.md：不能凭型号名猜），所以别的密钥一律不替他连。
 */
export function externalAutoConnectSource(
  tool: ExternalToolId,
  providers: AppConfigSummary['providers'] | null,
  keys: readonly Pick<AccountKey, 'id' | 'group'>[],
): ExternalAutoConnectChoice | null {
  const preferred = clientConnections.find((entry) => entry.id === tool)?.preferredProvider
  if (!preferred) return null
  const source = initialClientSource(tool, preferred, clientKeySources, providers, keys)
  if (tool === 'opencode' && source !== 'configured:codex') return null
  const configured = clientKeySources.find((entry) => source === `configured:${entry.id}`)
  if (configured) return { credential: { kind: 'configured', provider: configured.id }, model: configuredSourceModel(tool, source, providers) }
  const key = keys.find((entry) => source === `account:${entry.id}`)
  return key ? { credential: { kind: 'account', keyId: key.id }, model: '' } : null
}

/**
 * 自动连一次。型号照配置窗口「保存并检测」的规矩挑：原来就填着、这把密钥也能用的留着，Claude Desktop 再按
 * Claude Code 那套在 Claude 型号里挑；挑不准就不保存。写之前主进程还会排在写配置的队里再核一遍「从没配置过、
 * 没开着」（automatic），客户这几秒里自己保存过的不会被盖掉。stillCurrent 为假（换了账号、退出登录）就停。
 * 永不抛错：没连成的原因放在结果里，调用方只记运行日志。
 */
export async function autoConnectExternalClient(
  bridge: ExternalAutoConnectBridge,
  status: ExternalClientStatus,
  stillCurrent: () => boolean,
): Promise<ExternalAutoConnectOutcome> {
  const tool = status.tool
  try {
    // 密钥列表没读到时照配置窗口那样只看工具里配着的那几把，不因此整次不连。
    const [config, keys] = await Promise.all([
      bridge.getConfig(),
      readAllAccountKeys((query) => bridge.getAccountKeys(query)).then((page) => page.keys.filter((key) => key.status === 1), (): AccountKey[] => []),
    ])
    if (!stillCurrent()) return { kind: 'skipped', reason: 'account-changed' }
    const choice = externalAutoConnectSource(tool, config.providers, keys)
    if (!choice) return { kind: 'skipped', reason: 'no-key' }
    const listed = choice.credential.kind === 'configured'
      ? await bridge.listConfiguredModels(choice.credential.provider)
      : await bridge.listAccountKeyModels(choice.credential.keyId)
    const model = detectedClientModel(tool, choice.model, listed)
    if (!model) return { kind: 'skipped', reason: 'no-model' }
    if (!stillCurrent()) return { kind: 'skipped', reason: 'account-changed' }
    const request: ExternalClientConfigRequest = { credential: choice.credential, model, automatic: true, ...(tool === 'opencode' ? { protocol: 'responses' as const } : {}) }
    const saved = await bridge.configureExternalTool(tool, request)
    return { kind: 'connected', model: saved.model, verified: saved.connection ? connectionCheckView(saved.connection).tone === 'ok' : false }
  } catch (cause) {
    return { kind: 'failed', message: errorMessage(cause, '没有连上') }
  }
}

const triggerLabels: Record<ExternalAutoConnectTrigger, string> = { install: '装好后', login: '登录后' }

const skipReasonLabels: Record<Extract<ExternalAutoConnectOutcome, { kind: 'skipped' }>['reason'], string> = {
  'no-key': '挑不出能自动用的密钥',
  'no-model': '这把密钥里挑不出拿得准的型号',
  'account-changed': '账号中途变了',
}

/**
 * 进运行日志的那一行：自动连了谁、没连的为什么。界面上不说（单子没给字），客服拿到报告才看得出「装好了怎么
 * 没连上」。只写客户端名、原因和主进程给的中文失败原因，不带 Key、地址或型号（I13）。
 */
export function describeExternalAutoConnect(
  tool: ExternalToolId,
  trigger: ExternalAutoConnectTrigger,
  outcome: ExternalAutoConnectOutcome,
): { level: RendererLogLevel; message: string } {
  const name = clientConnections.find((entry) => entry.id === tool)?.name ?? tool
  const head = `${name} 自动连接（${triggerLabels[trigger]}）`
  if (outcome.kind === 'connected') return { level: outcome.verified ? 'info' : 'warn', message: `${head}：已写好${outcome.verified ? '' : '，连接自检没通过'}` }
  if (outcome.kind === 'skipped') return { level: 'info', message: `${head}：没连，${skipReasonLabels[outcome.reason]}` }
  return { level: 'warn', message: `${head}：没连成，${outcome.message.replace(/[。.\s]+$/, '')}` }
}

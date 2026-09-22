import { cliCatalog, type ProviderId } from './catalog'
import type { ConnectionCheckLayer, ConnectionCheckResult } from './connection-check'

/**
 * 一键切换账号来源（首页工具行「切到当前账号 / 切回官方账号」）。
 *
 * 用户是小白，这里替他把整条链路走完：先进备份页的备份（backups.ts 现有格式，
 * reason 'pre-save'），再写配置（切到当前账号时顺带挪开会抢道的官方凭据），再
 * 用现有连接自检确认能用；自检明确说配置不对时整体恢复到切换前（I9 的第二层：
 * 单次写入的两阶段提交之外，跨文件、跨步骤的回滚靠这份备份）。
 *
 * 这里只编排，不碰文件：每一步都由调用方注入，便于在测试里逐步打断。
 */
export type AccountSourceTarget = 'account' | 'official'

export interface AccountSourceSwitchResult {
  provider: ProviderId
  target: AccountSourceTarget
  /** 切换前那份备份；备份页里能找到它。 */
  backupId: string
  /** 切到当前账号且连接自检通过。切回官方时恒为 false（官方账号不替用户发请求）。 */
  verified: boolean
  /** 切回官方后这台电脑上还没有官方登录，要用户自己在工具里登录一次。 */
  loginRequired: boolean
  /** 直接上屏的一句中文。 */
  message: string
}

export interface AccountSourceSwitchDependencies {
  /** 切换前 CLI 是否选的是官方账号（决定回滚时把记号恢复成什么）。 */
  wasOfficial(provider: ProviderId): boolean
  createBackup(provider: ProviderId): { id: string }
  /** 恢复切换前那份备份，并把恢复出来的配置登记好来源。 */
  restoreBackup(id: string): void | Promise<void>
  /** 用当前账号的专属 Key 写配置；失败抛错。挪开官方凭据在写入里一并完成。 */
  writeAccountConfig(provider: ProviderId): Promise<void>
  writeOfficialConfig(provider: ProviderId): Promise<void>
  setOfficialPreference(provider: ProviderId, official: boolean): Promise<void>
  /** 把写入当前账号时挪开的官方凭据放回原处。 */
  restoreOfficialCredentials(provider: ProviderId): Promise<void>
  checkConnection(provider: ProviderId): Promise<ConnectionCheckResult>
  officialLoginPresent(provider: ProviderId): boolean | null
  log?(level: 'info' | 'warn', event: string, message: string, detail?: Record<string, unknown>): void
}

/**
 * 这些层的失败说明「刚写进去的配置本身用不了」（unconfigured 在刚写完之后出现，
 * 同样说明写入没有落到 CLI 真正读的地方），留着只会让用户打开工具就报错，
 * 所以回滚。网络、额度、未知不回滚：配置是对的，只是此刻确认不了或余额不够，
 * 切回官方反而让用户以为切换没生效。
 */
const rollbackLayers: ReadonlySet<ConnectionCheckLayer> = new Set<ConnectionCheckLayer>([
  'unconfigured', 'config', 'credential', 'group', 'model', 'protocol',
])

/**
 * 自检把 502/504、Cloudflare 的 520-526 和拦截页、返回网页而不是 JSON 都落进
 * credential / protocol 层，但那时服务本身在维护或被拦，写进去的配置是对的：
 * 回滚并告诉用户「Key 有问题」两样都错。503 单独看：new-api 用它表示分组下
 * 没有可用渠道，带着分组字样时仍是分组问题。
 */
const serviceUnavailableStatuses: ReadonlySet<number> = new Set([502, 504, 520, 521, 522, 523, 524, 525, 526])
const groupHints = ['无可用渠道', '无可用的渠道', '当前分组', '分组', '渠道', 'no available channel', 'no channel', 'group']
// new-api 的令牌额度用完回的是 401「该令牌额度已用尽」，自检按状态码归成了密钥被拒。
const quotaHints = ['额度', '余额', '配额', '欠费', 'quota', 'insufficient', 'balance', 'credit']

export type SwitchCheckVerdict = 'passed' | 'rollback' | 'serviceUnavailable' | 'quota' | 'unverified'

function looksLikeServiceOutage(status: number | null, detail: string): boolean {
  if (status !== null && serviceUnavailableStatuses.has(status)) return true
  const lowered = detail.toLowerCase()
  if (status === 503 && !groupHints.some((hint) => lowered.includes(hint))) return true
  if (/^\s*<(!doctype|html|head|body)/.test(lowered) || lowered.includes('<html')) return true
  return lowered.includes('cloudflare') || lowered.includes('cf-ray') || lowered.includes('attention required')
}

export function judgeSwitchCheck(check: Pick<ConnectionCheckResult, 'ok' | 'layer' | 'status' | 'detail'>): SwitchCheckVerdict {
  if (check.ok) return 'passed'
  const detail = check.detail ?? ''
  if (looksLikeServiceOutage(check.status, detail)) return 'serviceUnavailable'
  // 429 也落在额度层，但多半只是请求太频繁，不能说成额度用完。
  if (check.layer === 'quota' && check.status !== 429) return 'quota'
  if ((check.status === 401 || check.status === 403) && quotaHints.some((hint) => detail.toLowerCase().includes(hint))) return 'quota'
  return rollbackLayers.has(check.layer) ? 'rollback' : 'unverified'
}

export function shouldRollBackAfterCheck(check: Pick<ConnectionCheckResult, 'ok' | 'layer' | 'status' | 'detail'>): boolean {
  return judgeSwitchCheck(check) === 'rollback'
}

function toolName(provider: ProviderId): string {
  return cliCatalog[provider].name
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error)
}

/** 正在运行的 CLI 与 Codex 桌面端都把凭据缓存在内存里，不重开不会换账号。 */
export function restartHint(provider: ProviderId): string {
  return provider === 'codex'
    ? '已经开着的 Codex（包括桌面端）要关掉重开才会换过来。'
    : `已经开着的 ${toolName(provider)} 要关掉重开才会换过来。`
}

export function officialLoginHint(provider: ProviderId): string {
  switch (provider) {
    case 'claude':
      return '这台电脑还没登录过 Claude 账号：打开 Claude Code 后输入 /login，按提示登录。'
    case 'codex':
      return '这台电脑还没登录过 ChatGPT 账号：打开 Codex 后按提示用 ChatGPT 账号登录。'
    case 'gemini':
      return '这台电脑还没登录过 Google 账号：打开 Gemini CLI 后按提示用 Google 企业版账号登录。'
    case 'grok':
      return '打开 Grok CLI 后按提示登录。'
  }
}

export async function switchAccountSource(
  deps: AccountSourceSwitchDependencies,
  provider: ProviderId,
  target: AccountSourceTarget,
): Promise<AccountSourceSwitchResult> {
  const wasOfficial = deps.wasOfficial(provider)
  let backupId: string
  try {
    backupId = deps.createBackup(provider).id
  } catch (error) {
    throw new Error(`切换前的备份没有完成，已取消切换，配置没有改动：${errorText(error)}`)
  }

  async function rollBack(): Promise<string | null> {
    const failures: string[] = []
    try { await deps.restoreBackup(backupId) } catch (error) { failures.push(errorText(error)) }
    if (target === 'account') {
      try { await deps.restoreOfficialCredentials(provider) } catch (error) { failures.push(errorText(error)) }
    }
    try { await deps.setOfficialPreference(provider, wasOfficial) } catch (error) { failures.push(errorText(error)) }
    if (failures.length === 0) return null
    deps.log?.('warn', 'account-source.rollback-failed', `${toolName(provider)} 切换失败后没能完整恢复`, { provider, target, backupId, failures })
    return failures.join('；')
  }

  function failure(prefix: string, rollbackFailure: string | null): Error {
    return new Error(rollbackFailure
      ? `${prefix}自动恢复也没有完成（${rollbackFailure}），请到「备份」里恢复切换前那一份。`
      : `${prefix}已恢复到切换前的配置。`)
  }

  if (target === 'official') {
    try {
      await deps.writeOfficialConfig(provider)
    } catch (error) {
      throw failure(`切回官方账号没有完成：${errorText(error)}。`, await rollBack())
    }
    const present = deps.officialLoginPresent(provider)
    const loginRequired = present === false
    deps.log?.('info', 'account-source.switched', `${toolName(provider)} 已切回官方账号`, { provider, target, backupId, loginRequired })
    return {
      provider, target, backupId, verified: false, loginRequired,
      message: `已切回官方账号，原来的配置已备份。${loginRequired ? officialLoginHint(provider) : restartHint(provider)}`,
    }
  }

  try {
    await deps.writeAccountConfig(provider)
  } catch (error) {
    throw failure(`切到当前账号没有完成：${errorText(error)}。`, await rollBack())
  }

  let check: ConnectionCheckResult | null = null
  try {
    check = await deps.checkConnection(provider)
  } catch (error) {
    deps.log?.('warn', 'account-source.check-failed', `${toolName(provider)} 切换后的连接自检没有完成`, { provider, reason: errorText(error) })
  }
  const verdict = check ? judgeSwitchCheck(check) : null
  if (check && verdict === 'rollback') {
    deps.log?.('warn', 'account-source.rolled-back', `${toolName(provider)} 切到当前账号后自检没通过，已回滚`, { provider, layer: check.layer, backupId })
    throw failure(`当前账号在 ${toolName(provider)} 上没有连通：${check.summary}。${check.nextStep ? `${check.nextStep}。` : ''}`, await rollBack())
  }
  const verified = verdict === 'passed'
  deps.log?.('info', 'account-source.switched', `${toolName(provider)} 已切到当前账号`, { provider, target, backupId, verified, verdict, layer: check?.layer ?? null })
  const status = verified ? '连接自检通过。'
    : verdict === 'serviceUnavailable' ? '不过服务暂时不可用，这次没能确认能用，稍后再试。'
      : verdict === 'quota' ? '不过当前账号的额度已经用完，到「账号」页充值后就能用。'
        : check ? `这次没能确认能用：${check.summary}。`
          : '连接自检没有完成，稍后可以在检查页再测一次。'
  return {
    provider, target, backupId, verified, loginRequired: false,
    message: `已切到当前账号，${status}${restartHint(provider)}`,
  }
}

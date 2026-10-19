// 官方账号与当前账号之间来回切的那一段（#1070 第 3 步，从 system-service.ts 的 createSystemService 原样搬来）：
// 切回官方账号、改用当前账号时挪开或放回 Claude Code 登录留下的官方 Console Key，恢复备份以后对齐来源记号，
// 以及 Codex 跟着账号开关星芒AI技能。保存配置那一段（createSystemService 里的 saveConfig）也用这里的挪开、放回和撤回。
//
// 各簇共用的那份在 system-service-context.ts。这里只 import system-service.ts 的类型。
import path from 'node:path'
import { isRetiredProviderId, type ProviderId } from './catalog'
import {
  classifyCodexConfigProfile,
  forgetStaleGeminiUsageStatisticsRecord,
  moveClaudeConsoleKeyAside,
  type NativeConfigInspection,
  restoreClaudeConsoleKey,
  switchProviderToOfficialAccount,
} from './config-files'
import { errorCodeClause } from './failure-wording'
import type { ConfigSavePayload } from './system-service'
import type { ServiceContext } from './system-service-context'
import type { ToolConfigOwnership } from './tool-config-ownership'
import { adoptRestoredXingmangAiSkillOff, syncXingmangAiSkillCodexAvailability } from './xingmang-ai-skill'

/**
 * 恢复备份是用户点名的动作：恢复出来的配置不该在下一次扫描时被当成「被人改过」，
 * 也不该被自动写 Key 的流程悄悄覆盖。所以恢复后按恢复出来的那份重新登记来源：
 * Key 正是当前账号由本软件签发的那把，记成账号来源（和本软件自己写的一样）；
 * 其余一律记成手动来源（和「就用现在这份」同一个意思，以后不提示、不自动改写）。
 * 返回 null = 不用登记：没有 Key 时来源本来就读成未配置 / 未知，已经对得上的记录
 * 也不必重写。
 */
export function planRestoredConfigOwnership(input: {
  current: ToolConfigOwnership
  hasApiKey: boolean
  matchesRelay: boolean
  owner: string | null
  isAccountKey: boolean
}): 'account' | 'manual' | null {
  if (!input.hasApiKey) return null
  if (input.current === 'account' || input.current === 'manual') return null
  return input.owner && input.matchesRelay && input.isAccountKey ? 'account' : 'manual'
}

/**
 * 备份页恢复出来的这份配置是哪一边的（#1080），「选了官方账号」的记号和 Claude 的官方 Key
 * 照它对齐。只认两种看得准的，口径跟首页 sourceFor 对得上，只是更保守：
 * - 'account'：地址是当前账号所在的站，带着 Key。
 * - 'official'：官方登录的样子。Codex 是 ChatGPT 登录、没有接到别的连接上；其余工具什么 Key 和
 *   地址都没写。Grok 的 config.toml 装好就有，还要真有一份 Grok 登录才算。
 * 别家中转、半截的（ChatGPT 令牌配着中转地址）、工具自己都读不了的，返回 null，一样都不动。
 */
export function restoredAccountSide(
  provider: ProviderId,
  restored: Pick<NativeConfigInspection, 'exists' | 'hasApiKey' | 'matchesRelay' | 'actualBaseUrl'
    | 'codexAuthMode' | 'configBroken' | 'codexAuthBroken' | 'grokLoginMode'>,
): 'account' | 'official' | null {
  if (isRetiredProviderId(provider)) return null
  if (restored.configBroken === true || restored.codexAuthBroken === true) return null
  if (provider === 'codex' && restored.codexAuthMode === 'chatgpt') return restored.actualBaseUrl ? null : 'official'
  if (restored.hasApiKey && restored.matchesRelay) return 'account'
  if (!restored.exists || restored.hasApiKey || restored.actualBaseUrl) return null
  if (provider === 'grok' && !restored.grokLoginMode) return null
  return 'official'
}

export function createOfficialCredentialService(context: ServiceContext) {
  const {
    store, serviceOptions, providerRoots, runtimeLog, configOwnership, serializeConfigWrite, providerRelaySite,
    inspectNativeProviderConfig, credentialFailureReason,
  } = context

  function officialKeyRestoreFailedMessage(error: unknown): string {
    return `Claude Code 原来的官方密钥没能放回原处。关掉 Claude Code 后再点一次「切回官方账号」；还不行请找客服${errorCodeClause(error)}。`
  }

  /** 配置写入失败后撤回刚才对官方 Key 的挪动；撤不回来要让用户知道，不能只报配置那一半。 */
  function withCredentialUndo(error: unknown, undo: () => unknown, leftover: string): unknown {
    try {
      undo()
      return error
    } catch {
      // undo 自己已经记了带原因的日志，这里只告诉用户现在是什么状态。
      const message = error instanceof Error ? error.message : String(error)
      return new Error(`${message}（${leftover}）`)
    }
  }

  /**
   * Console 登录留下的 primaryApiKey 会以 x-api-key 跟着每个请求出去，中转拿它
   * 覆盖掉当前账号的 Key（config-files.ts 顶部那段）。挪不开就抛错，由调用方放弃
   * 这次写入：配置写成当前账号而 Key 还在，打开工具就是 401。返回是否真的挪了一把。
   */
  function moveOfficialCredentialsAside(): boolean {
    try {
      const moved = moveClaudeConsoleKeyAside(providerRoots)
      if (moved) runtimeLog?.log('info', 'config', 'official-credentials.moved', 'Claude Code 的官方 Console Key 已挪到一边，切回官方账号时放回', { provider: 'claude' })
      return moved
    } catch (error) {
      const reason = credentialFailureReason(error)
      runtimeLog?.log('warn', 'config', 'official-credentials.move-failed', 'Claude Code 的官方 Console Key 没能挪开，本次配置没有写入', { provider: 'claude', reason })
      // 原话已经记进上面那条日志，上屏只说结果和下一步（#1100 第1条）。
      throw new Error(`Claude Code 原来登录留下的官方密钥没能挪开，配置没有改动。关掉 Claude Code 后再试；还不行请找客服${errorCodeClause(error)}。`, { cause: error })
    }
  }

  /** 放回挪开的官方 Key；失败抛错，回滚方据此知道恢复不完整。返回是否改动了文件。 */
  function restoreOfficialCredentialsNow(): boolean {
    try {
      return restoreClaudeConsoleKey(providerRoots)
    } catch (error) {
      const reason = credentialFailureReason(error)
      runtimeLog?.log('warn', 'config', 'official-credentials.restore-failed', 'Claude Code 的官方 Console Key 没能放回原处', { provider: 'claude', reason })
      throw new Error(officialKeyRestoreFailedMessage(error), { cause: error })
    }
  }

  async function restoreOfficialCredentials(provider: ProviderId): Promise<void> {
    if (provider !== 'claude') return
    await serializeConfigWrite(async () => { restoreOfficialCredentialsNow() })
  }

  async function setOfficialSourcePreference(provider: ProviderId, official: boolean): Promise<void> {
    await serializeConfigWrite(async () => {
      await store.setOfficialProvider(provider, official)
      if (provider === 'codex') await applyXingmangAiSkillForCodexAccount(official)
    })
  }

  async function adoptRestoredConfig(
    provider: ProviderId,
    isAccountKey: (apiKey: string) => boolean,
    options: { fromBackupsPage?: boolean } = {},
  ): Promise<void> {
    await serializeConfigWrite(async () => {
      // 恢复出来的 settings.json 不一定还带着星芒写的统计开关（#834 F03），对不上就作废那笔记录。
      // 放在登记来源前面：那一步失败时这里也要做完。
      if (provider === 'gemini') {
        try {
          forgetStaleGeminiUsageStatisticsRecord(providerRoots)
        } catch (error) {
          runtimeLog?.log('warn', 'config', 'gemini.statistics-record.forget-failed', 'Gemini CLI 恢复备份后没能作废星芒写过的统计开关记录', {
            reason: credentialFailureReason(error),
          })
        }
      }
      // 星芒AI技能的记录也不跟着备份恢复：备份页恢复出来的星芒配置里技能关着，是客户自己关的
      // （#834 F07），改用当前账号时不能打开。同样放在登记来源前面。
      if (provider === 'codex' && options.fromBackupsPage) {
        try {
          const current = inspectNativeProviderConfig('codex')
          const siteBaseUrl = providerRelaySite('codex', current).providerBaseUrls.codex
          await adoptRestoredXingmangAiSkillOff({
            userHome: providerRoots.userHome,
            officialCodex: (store.read().officialProviders ?? []).includes('codex'),
            configPath: path.join(providerRoots.codexHome, 'config.toml'),
            isXingmangConfig: (config) => classifyCodexConfigProfile(config, siteBaseUrl) === 'relay',
          })
        } catch (error) {
          runtimeLog?.log('warn', 'config', 'codex.skill-record.adopt-failed', 'Codex 恢复备份后没能记下星芒AI技能是客户自己关的', {
            reason: credentialFailureReason(error),
          })
        }
      }
      const owner = serviceOptions.getExternalClientAccountId?.() ?? null
      const restored = inspectNativeProviderConfig(provider)
      const source = planRestoredConfigOwnership({
        current: configOwnership.read(provider, restored, owner),
        hasApiKey: restored.hasApiKey,
        matchesRelay: restored.matchesRelay,
        owner,
        isAccountKey: restored.hasApiKey && isAccountKey(restored.apiKey),
      })
      if (source) await configOwnership.write(provider, restored, source, owner)
    })
  }

  async function alignRestoredAccountSource(provider: ProviderId): Promise<void> {
    await serializeConfigWrite(async () => {
      const side = restoredAccountSide(provider, inspectNativeProviderConfig(provider))
      if (!side) return
      const official = side === 'official'
      // 和 saveConfig / switchToOfficialAccount 一样：接中转的挪开官方 Console Key（不挪它会顶掉中转的 Key，
      // 一用就是无效令牌），官方的放回来。配置已经是恢复出来的那份了，挪不动也照样往下对齐记号。
      let credentialFailure: unknown = null
      if (provider === 'claude') {
        try {
          const changed = official ? restoreClaudeConsoleKey(providerRoots) : moveClaudeConsoleKeyAside(providerRoots)
          if (changed) {
            runtimeLog?.log('info', 'config', official ? 'official-credentials.restored' : 'official-credentials.moved',
              official ? '恢复的是官方账号的配置，Claude Code 的官方 Console Key 已放回' : '恢复的是当前账号的配置，Claude Code 的官方 Console Key 已挪到一边，切回官方账号时放回',
              { provider })
          }
        } catch (error) {
          credentialFailure = error
          runtimeLog?.log('warn', 'config', official ? 'official-credentials.restore-failed' : 'official-credentials.move-failed',
            official ? '恢复备份后 Claude Code 的官方 Console Key 没能放回原处' : '恢复备份后 Claude Code 的官方 Console Key 没能挪开',
            { provider, reason: credentialFailureReason(error) })
        }
      }
      if ((store.read().officialProviders ?? []).includes(provider) !== official) {
        await store.setOfficialProvider(provider, official)
        if (provider === 'codex') await applyXingmangAiSkillForCodexAccount(official)
      }
      if (credentialFailure) {
        // 「无效令牌」留着：account-cli-provisioner.ts 的 isCredentialFailure 认它。
        throw new Error(official
          ? officialKeyRestoreFailedMessage(credentialFailure)
          : `Claude Code 原来登录留下的官方密钥没能挪开，现在打开会报无效令牌。关掉 Claude Code 后再点一次「改用当前账号」；还不行请找客服${errorCodeClause(credentialFailure)}。`,
        { cause: credentialFailure })
      }
    })
  }

  async function switchToOfficialAccount(provider: ProviderId, mode: ConfigSavePayload['mode'] = 'merge') {
    return serializeConfigWrite(async () => {
      const activeSite = providerRelaySite(provider, inspectNativeProviderConfig(provider), true)
      // 与 saveConfig 对称：先放回官方 Key，放不回就不切；切换失败再把 Key 挪开。
      const restoredConsoleKey = provider === 'claude' && restoreOfficialCredentialsNow()
      let result: ReturnType<typeof switchProviderToOfficialAccount>
      try {
        result = switchProviderToOfficialAccount(provider, providerRoots, {}, activeSite.providerBaseUrls, mode)
      } catch (error) {
        if (restoredConsoleKey) throw withCredentialUndo(error, moveOfficialCredentialsAside, '原来登录留下的官方 Key 已经放回，可能会和当前账号的 Key 冲突，请再切一次')
        throw error
      }
      await store.setOfficialProvider(provider, true)
      if (provider === 'codex') await applyXingmangAiSkillForCodexAccount(true)
      return result
    })
  }

  async function applyXingmangAiSkillForCodexAccount(official: boolean): Promise<void> {
    try {
      await syncXingmangAiSkillCodexAvailability({
        userHome: providerRoots.userHome,
        officialCodex: official,
        configPath: path.join(providerRoots.codexHome, 'config.toml'),
      })
    } catch {
      // Account switch already committed. Skill toggle is best-effort so a
      // locked or unreadable config.toml cannot roll back the user's choice.
    }
  }

  return { restoreOfficialCredentialsNow, moveOfficialCredentialsAside, withCredentialUndo, applyXingmangAiSkillForCodexAccount, switchToOfficialAccount, adoptRestoredConfig, setOfficialSourcePreference, alignRestoredAccountSource, restoreOfficialCredentials }
}

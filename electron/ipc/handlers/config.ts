// 主窗口业务通道的处理器：工具配置的读写、切换账号来源、修提醒设置、补模板缺省项、查型号。
// 换线路定点改写要的账号信息也在这里交给 system-service，撤销时一并收回。
// #1070 第 7 步从 ipc.ts 原样搬来：按域一个文件，ipc.ts 只管组装，各域共用的东西在 context.ts。
import os from 'node:os'
import { apiKeyDigest } from '../../backups'
import { isActiveProviderId, type ProviderId } from '../../catalog'
import { configureManagedClis, type ManagedCliKeyStoreLike } from '../../account-cli-provisioner'
import { AccountSourceServiceUnavailableError, switchAccountSource } from '../../account-source-switch'
import { emptyRunningToolsReport } from '../../running-tools'
import { redactHomeDirectory } from '../../startup-log'
import { isExternalToolId, parseExternalClientConfigRequest } from '../../external-client-contract'
import { assertOpenableConfigDirectory } from '../../config-directory'
import { defaultProviderConfigRoots, providerConfigRoot } from '../../codex-home'
import type { CliModelHints } from '../../cli-model-defaults'
import type { ToolModelCheck, ToolTemplateFillResult } from '../../ipc-contract'
import { parseConfigSavePayload, parseRunningToolsProviders } from '../parsers/tools'
import type { IpcHandlerContext } from './context'

export function registerConfigHandlers(ctx: IpcHandlerContext): () => void {
  const {
    options, registerTrustedHandler, startupGate, service, accountService, externalShell,
    logManagedCliFailures, automaticProvisioning, currentBackupAccountId, readBackupAccountContext,
    backupBeforeReset, assertAccountSessionUser, revealAccountKeySecret,
  } = ctx
  registerTrustedHandler('config:get', () => {
    // 账号还在恢复：此时读到的会话是未登录，来源判定没有账号可比，一律只会是
    // unknown。标出来让界面知道这是「待定」而不是「来源不明」，恢复完再补读。
    // 恢复联不上、登录留着等重试的那段时间同理。
    if (startupGate?.pending() || options.realmAccounts?.stalledAccount()) {
      return { ...service.getConfig(options.previewOnboarding), ownershipPending: true }
    }
    const session = accountService.getSessionState()
    const userId = session.account?.userId
    if (options.previewOnboarding || !session.authenticated || !userId || !options.managedCliKeys) {
      return service.getConfig(options.previewOnboarding)
    }
    const activeSite = () => accountService.getActiveSiteId?.() ?? options.realmAccounts?.getSiteId() ?? 'solov'
    const siteId = activeSite()
    const revision = accountService.getSessionRevision?.()
    return (async () => {
      // Read only the current realm's existing cache. A display scan must not
      // create keys, call a model, or establish automatic overwrite consent.
      let keys: Awaited<ReturnType<ManagedCliKeyStoreLike['read']>> = []
      try { keys = await options.managedCliKeys!.read(userId) } catch { /* Unknown ownership stays protected. */ }
      // 开机后第一次读到本账号的配置时，先把指向旧位置的提醒设置改好再报（修不好首页照旧给「修好它」）。
      // 放在下面的会话复核之前：改的时候换了账号，这次读取照样作废。
      await service.autoRepairStaleCliHooks?.().catch(() => [])
      const current = accountService.getSessionState()
      if (!current.authenticated || current.account?.userId !== userId || activeSite() !== siteId
        || accountService.getSessionRevision?.() !== revision) throw new Error('账号会话已变更，请重新检测工具配置')
      return service.getConfig(options.previewOnboarding, keys)
    })()
  })
  registerTrustedHandler('config:reveal-api-key', (_event, provider: unknown) => {
    if (!isActiveProviderId(provider)) throw new Error('未知的 CLI 类型')
    return service.revealApiKey(provider, options.previewOnboarding)
  })
  registerTrustedHandler('config:save', (_event, payload: unknown) => {
    const revision = accountService.getSessionRevision?.()
    const check = () => {
      if (revision !== undefined && accountService.getSessionRevision?.() !== revision) throw new Error('账号已变化，请重新配置')
    }
    const parsed = parseConfigSavePayload(payload)
    const save = () => options.realmAccounts ? service.saveConfig(parsed, options.previewOnboarding, check)
      : service.saveConfig(parsed, options.previewOnboarding)
    if (parsed.mode !== 'reset') return save()
    return backupBeforeReset(parsed.provider).then(save)
  })
  registerTrustedHandler('config:open-directory', async (_event, provider: unknown) => {
    if (!isActiveProviderId(provider)) throw new Error('未知的 CLI 类型')
    const directory = providerConfigRoot(provider, options.providerRoots ?? defaultProviderConfigRoots())
    assertOpenableConfigDirectory(directory)
    await externalShell.openPath(directory)
    return true
  })
  registerTrustedHandler('config:configure-external-tool', async (_event, tool: unknown, input: unknown) => {
    if (!isExternalToolId(tool)) {
      throw new Error('未知的外部客户端类型')
    }
    const parsed = parseExternalClientConfigRequest(input)
    const revision = accountService.getSessionRevision?.()
    const assertCurrent = () => {
      if (revision !== undefined && accountService.getSessionRevision?.() !== revision) throw new Error('账号已变化，请重新配置')
    }
    let apiKey: string
    if (parsed.credential.kind === 'account') {
      const userId = accountService.getSessionState().account?.userId
      if (!userId) throw new Error('请先登录星芒账号')
      apiKey = await revealAccountKeySecret(parsed.credential.keyId, userId)
      assertAccountSessionUser(userId)
    } else if (parsed.credential.kind === 'configured') {
      const provider = parsed.credential.provider
      const config = service.getConfig(options.previewOnboarding).providers[provider]
      if (!config.hasApiKey || !config.matchesRelay) throw new Error('该工具没有当前账号的可用密钥，请重新选择密钥来源')
      apiKey = service.revealApiKey(provider, options.previewOnboarding)
    } else apiKey = parsed.credential.apiKey
    assertCurrent()
    // 记下这把是从哪来的：Claude Code 换 Key 时，客户自己填的那把不跟着换（#1113）。
    return service.configureExternalTool(tool, { apiKey, model: parsed.model, protocol: parsed.protocol }, assertCurrent, parsed.credential.kind)
  })
  registerTrustedHandler('config:switch-to-official-account', (_event, provider: unknown, mode: unknown) => {
    if (!isActiveProviderId(provider)) throw new Error('未知的 CLI 类型')
    if (mode !== undefined && mode !== 'merge' && mode !== 'reset') throw new Error('未知的配置写入模式')
    if (mode === 'reset') return backupBeforeReset(provider).then(() => service.switchToOfficialAccount(provider, 'reset'))
    return mode === undefined ? service.switchToOfficialAccount(provider) : service.switchToOfficialAccount(provider, mode)
  })
  // 同一个工具的一键切换一次只跑一个（全面检测 Q35）。切换要备份、写入、自检，
  // 失败还要回滚；两次叠在一起时，后一次的备份会拍到前一次写了一半的配置，两边
  // 的回滚也会互相覆盖。同方向的重复点击共用正在跑的那一次，反方向的直接拒绝。
  const accountSourceSwitches = new Map<ProviderId, { target: 'account' | 'official'; promise: Promise<unknown> }>()
  registerTrustedHandler('config:switch-account-source', async (_event, provider: unknown, target: unknown) => {
    if (!isActiveProviderId(provider)) throw new Error('未知的 CLI 类型')
    if (target !== 'account' && target !== 'official') throw new Error('未知的账号来源')
    const running = accountSourceSwitches.get(provider)
    if (running) {
      if (running.target === target) return running.promise
      throw new Error('这个工具正在切换账号，等这次切完再试')
    }
    const promise = switchAccountSourceOnce(provider, target)
    accountSourceSwitches.set(provider, { target, promise })
    try {
      return await promise
    } finally {
      if (accountSourceSwitches.get(provider)?.promise === promise) accountSourceSwitches.delete(provider)
    }
  })
  registerTrustedHandler('config:repair-cli-hooks', async (_event, provider: unknown) => {
    if (!isActiveProviderId(provider)) throw new Error('未知的 CLI 类型')
    if (!service.repairCliHooks) throw new Error('这个版本还不能修提醒设置')
    // 和保存配置同一份备份：「设置 › 备份迁移」里能找回改之前的样子。
    options.backupStore.create(provider, 'pre-save', undefined, await readBackupAccountContext())
    return service.repairCliHooks(provider)
  })
  async function switchAccountSourceOnce(provider: ProviderId, target: 'account' | 'official') {
    if (target === 'account' && !accountService.getSessionState().account?.userId) throw new Error('请先登录账号，再改用当前账号')
    // 与备份页同一套账号上下文：备份里记下哪些 Key 是当前账号签发的，回滚后
    // 恢复出来的配置照样按来源登记，首页不会因此冒出「配置被改过」。
    const identity = currentBackupAccountId()
    const context = await readBackupAccountContext()
    return switchAccountSource({
      wasOfficial: (id) => (service.readStoredConfig().officialProviders ?? []).includes(id),
      createBackup: (id) => options.backupStore.create(id, 'pre-save', undefined, context),
      restoreBackup: async (id) => {
        const result = options.backupStore.restore(id, context)
        const stillCurrent = context !== null && currentBackupAccountId() === identity
        // 同 backups:restore：配置已经恢复，登记来源失败只记日志，不算回滚失败。
        try {
          await service.adoptRestoredConfig(result.provider, (apiKey) => (
            stillCurrent && context.keyDigests.has(apiKeyDigest(apiKey))
          ))
        } catch (error) {
          options.runtimeLog.log('warn', 'config', 'account-source.adopt-failed', '切换回滚已恢复配置，但没能登记这份配置的来源', {
            provider: result.provider,
            reason: error instanceof Error ? error.message : String(error),
          })
        }
      },
      writeAccountConfig: async (id) => {
        // 工具自己读不了的配置，只更新要照着原文件改，只会报「写错了」；来源没确认时配置窗口里
        // 又只有这一颗按钮，点不到「重置为初始状态」（第三十批跟进项）。这时改走重置：这次切换
        // 开头已经在「备份」页留过一份，切不成照样从它恢复。
        const current = service.getConfig(options.previewOnboarding).providers[id]
        const mode = current?.configBroken === true || current?.codexAuthBroken === true ? 'reset' : 'merge'
        // 用户亲手点的切换：intent 'explicit' 才穿得过「来源未确认不自动改写」那道闸。
        // 切换来源没有确认丢弃读坏的额度记录；签发仍走保留限制、读坏就停止的入口。
        const outcome = await configureManagedClis(
          automaticProvisioning, service, [id], {}, options.previewOnboarding, options.managedCliKeys, mode, 'explicit',
        )
        logManagedCliFailures(outcome)
        if (outcome.failed.some((item) => item.serviceUnavailable)) throw new AccountSourceServiceUnavailableError()
        if (outcome.failed.length) throw new Error(outcome.failed.map((item) => item.message).join('；'))
        if (!outcome.configured.includes(id)) throw new Error('工具没有返回配置写入结果')
      },
      writeOfficialConfig: async (id) => { await service.switchToOfficialAccount(id, 'merge') },
      setOfficialPreference: async (id, official) => { await service.setOfficialSourcePreference?.(id, official) },
      restoreOfficialCredentials: async (id) => { await service.restoreOfficialCredentials?.(id) },
      checkConnection: (id) => options.diagnosticsService.checkConnection(id),
      officialLoginPresent: (id) => service.inspectOfficialLogin?.(id) ?? null,
      ...(service.inspectRunningTools ? { inspectRunning: (id: ProviderId) => service.inspectRunningTools!([id]) } : {}),
      // 失败原因可能带着配置文件的绝对路径（I13）：进日志前把主目录换掉。
      log: (level, event, message, detail) => options.runtimeLog.log(level, 'config', event, message, detail
        ? JSON.parse(redactHomeDirectory(JSON.stringify(detail), options.providerRoots?.userHome ?? os.homedir())) as Record<string, unknown>
        : undefined),
    }, provider, target)
  }
  registerTrustedHandler('tools:inspect-running', async (_event, providers: unknown) => {
    const parsed = parseRunningToolsProviders(providers)
    // 旧实现没有这项检测：全部报「看不出来」，界面退回「如果还开着」的说法。
    if (!service.inspectRunningTools) {
      return { ...emptyRunningToolsReport, unknown: parsed, codexDesktopRunning: parsed.includes('codex') ? null : false }
    }
    return service.inspectRunningTools(parsed)
  })
  registerTrustedHandler('tools:check-models', async (_event, provider: unknown): Promise<ToolModelCheck> => {
    if (!isActiveProviderId(provider)) throw new Error('未知的 CLI 类型')
    if (!service.checkToolModels) return { status: 'skipped' }
    return service.checkToolModels(provider)
  })
  // 读不到就当没有：配置窗口照旧按程序自带的那份挑，不为它报错。
  registerTrustedHandler('tools:cli-model-hints', async (): Promise<CliModelHints | null> => {
    if (!options.cliModelHints) return null
    try { return await options.cliModelHints() } catch { return null }
  })
  registerTrustedHandler('config:fill-template-defaults', async (_event, retry: unknown): Promise<ToolTemplateFillResult> => {
    if (retry !== undefined && typeof retry !== 'boolean') throw new Error('补设置参数格式错误')
    if (!service.fillToolTemplateDefaults) return { filled: [] }
    // 开机对账（xm 三线路 C9）：账号恢复以后，星芒账号工具配置还停在别的线路上的（上次没迁成、
    // 0.2.17 留下的），先定点改到当前线路，再补模板缺省项。补做那几回不用再对：失败有自己的重试。
    if (retry !== true) await service.followToolRoutes?.({ reason: 'startup' }).catch(() => undefined)
    const context = await readBackupAccountContext()
    return service.fillToolTemplateDefaults((provider) => { options.backupStore.create(provider, 'pre-save', undefined, context) }, retry === true)
  })
  // 换线路定点改写要的两件账号上的事：迁移前原件的备份带上账号信息，生图技能认当前账号签发过的 Key。
  service.bindToolRouteAccount?.({
    backup: async (provider) => {
      options.backupStore.create(provider, 'pre-save', undefined, await readBackupAccountContext())
    },
    ownedKeyIds: async () => {
      const account = accountService.getSessionState().account
      if (!account || !options.managedCliKeys) return new Set<number>()
      try {
        return new Set((await options.managedCliKeys.read(account.userId)).map((entry) => entry.id))
      } catch {
        return new Set<number>()
      }
    },
  })
  registerTrustedHandler('models:list', (_event, apiKey: unknown) => {
    if (typeof apiKey !== 'string' || apiKey.length > 4_096) {
      throw new Error('API Key 格式错误')
    }
    return service.fetchAvailableModels(apiKey)
  })
  registerTrustedHandler('models:list-configured', (_event, provider: unknown) => {
    if (!isActiveProviderId(provider)) throw new Error('未知的 CLI 类型')
    if (options.realmAccounts && !service.getConfig(options.previewOnboarding).providers[provider].matchesRelay) {
      throw new Error('已保存的密钥属于其他账号，请使用当前账号重新配置')
    }
    const apiKey = service.revealApiKey(provider, options.previewOnboarding)
    if (!apiKey) throw new Error('未读取到已保存的密钥')
    return service.fetchAvailableModels(apiKey)
  })
  return () => {
    service.bindToolRouteAccount?.(null)
  }
}

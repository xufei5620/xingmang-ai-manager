// 主窗口业务通道的处理器：账号密钥的列出、新建、修改、撤销、复制，签发并写进工具，写配置时可选的密钥。
// #1070 第 7 步从 ipc.ts 原样搬来：按域一个文件，ipc.ts 只管组装，各域共用的东西在 context.ts。
import { isActiveProviderId, isRetiredProviderId, type ProviderId } from '../../catalog'
import { accountKeyListTooLongMessage, findAccountKeyById, searchAccountKeys } from '../../account-key-quota'
import { ManagedKeyReplacementUnreadableError, managedKeyReplacementUnreadableRevokeMessage } from '../../managed-key-replacement-store'
import { configureManagedClis, syncManagedCliKeySummary } from '../../account-cli-provisioner'
import { resolveAccountKeyOptions } from '../../account-key-options'
import { loadAccountGroupHints, loadManagedCliGroups } from '../../managed-cli-groups'
import { XINGMANG_IMAGE_MCP_NO_NODE_WARNING, describeImageMcpWarnings, syncXingmangAiSkill } from '../../xingmang-ai-skill'
import type { AccountKey, AccountKeysPage } from '../../ipc-contract'
import {
  parseAccountKeyCliConfigurationInput,
  parseAccountKeyCreateInput,
  parseAccountKeysQuery,
  parseAccountKeyUpdateInput,
  parseAccountRevokeKeyId,
  parseManagedCliConfigurationInput,
} from '../parsers/account-keys'
import type { IpcHandlerContext } from './context'

export function registerAccountKeyHandlers(ctx: IpcHandlerContext): void {
  const {
    options, registerTrustedHandler, service, accountService, sensitiveClipboard, invalidateAccountKeyCaches,
    keyReplacements, replacementSlot, logManagedCliFailures, automaticProvisioning, explicitProvisioning,
    backupBeforeReset, assertAccountSessionUser, revealAccountKeySecret,
  } = ctx
  // 撤销前先认出这是不是某个工具在用、又设了上限或到期时间的 Key。读不到就先不撤：
  // 撤完再想知道新 Key 该照抄什么已经无从查起。
  const limitedManagedKey = async (userId: number, keyId: number): Promise<{ provider: ProviderId; key: AccountKey } | null> => {
    if (!options.managedCliKeys || options.previewOnboarding) return null
    // 本机记录读坏了（#475）：分不清这是不是哪个工具在用的 Key，不能当成「不是」。
    const cachedEntries = await options.managedCliKeys.read(userId).catch(() => null)
    const cached = cachedEntries?.find((entry) => entry.id === keyId)
    if (cachedEntries && !cached) return null
    let key: AccountKey | null
    try {
      key = await findAccountKeyById((query) => accountService.listKeys(query), keyId)
    } catch (error) {
      if (error instanceof Error && error.message === accountKeyListTooLongMessage) throw error
      throw new Error('没读到这把密钥的额度设置，先没撤销。请稍后再试。')
    }
    // 记录读坏时，只有不限额、不到期的 Key 撤了也没有限制可丢，照常撤；设了限制的
    // 不知道该记到哪个工具名下，撤了换新就会变成不限额，先停下。
    if (!cached) {
      if (key && key.unlimitedQuota && !key.expiredAt) return null
      throw new Error('没读到本机记着的工具密钥，分不清这把密钥是不是某个工具在用的，先没撤销。请重新打开软件后再试。')
    }
    // 本机记着这是某个工具在用的 Key，列表里却找不到：分不清它有没有上限，按不限额
    // 撤了再换新，就等于悄悄放开了上限。停下，不撤。
    if (!key) throw new Error('没在账号的密钥列表里找到这把密钥，先没撤销。刷新一下密钥列表再试。')
    if (key.unlimitedQuota && !key.expiredAt) return null
    return { provider: cached.provider, key }
  }
  registerTrustedHandler('account:sync-managed-cli-keys', async () => {
    await options.startupQuiet?.whenOver()
    const summary = await syncManagedCliKeySummary(automaticProvisioning, options.managedCliKeys)
    if (!options.xingmangAiSkill || accountService.getActiveSiteId?.() === 'solov-api') return summary
    try {
      const skill = await syncXingmangAiSkill({
        // 跟上面工具那一轮同一层包装：撤销后待补的额度设置照抄，读不到记录就停下，不另签一把不限额的 Codex Key。
        accountService: automaticProvisioning,
        bundledRoot: options.xingmangAiSkill.bundledRoot,
        userHome: options.xingmangAiSkill.userHome,
        // The expected endpoint comes from the active main-process route, not
        // the editable native URL or a preference awaiting an app restart.
        baseUrl: new URL(service.getConfig(false).providers.codex.baseUrl).origin,
        officialCodex: (service.readStoredConfig().officialProviders ?? []).includes('codex'),
        serializeConfigWrite: service.serializeToolConfigWrite,
        syncImageMcp: options.xingmangAiSkill.syncImageMcp,
        fetchAvailableModels: (apiKey) => service.fetchAvailableModels(apiKey),
        loadAccountGroupHints: () => loadAccountGroupHints(automaticProvisioning),
      })
      for (const warning of skill.directoryWarnings ?? []) {
        options.runtimeLog.log('warn', 'account', 'xingmang-ai-skill.sync', warning)
      }
      // 技能写进去了、画图工具却没登记上，以前只进日志：客户说「画一张」AI 不会，首页一个字没有。
      // 这里换成一句人话交给首页，那张提示自带「重新同步」，点了就整轮再登记一次。
      const imageMcpWarning = describeImageMcpWarnings(skill.imageMcpWarnings ?? [])
      // 缺 Node.js 的那句要不要上首页，渲染层跟着运行环境卡对 Node.js 的说法定，这里只把原因带过去。
      const imageMcpNeedsNode = (skill.imageMcpWarnings ?? []).includes(XINGMANG_IMAGE_MCP_NO_NODE_WARNING)
      if (skill.ready) return imageMcpWarning ? { ...summary, imageMcpWarning, ...(imageMcpNeedsNode ? { imageMcpNeedsNode } : {}) } : summary
      const imageSkillWarning = skill.reason || '星芒AI 生图密钥未完成初始化'
      options.runtimeLog.log('warn', 'account', 'xingmang-ai-skill.sync', imageSkillWarning)
      return { ...summary, imageSkillWarning }
    } catch (error) {
      const imageSkillWarning = error instanceof Error ? error.message : '星芒AI Skill 同步失败'
      options.runtimeLog.log('warn', 'account', 'xingmang-ai-skill.sync', imageSkillWarning)
      return { ...summary, imageSkillWarning }
    }
  })
  registerTrustedHandler('account:configure-managed-clis', (_event, input: unknown) => {
    const parsed = parseManagedCliConfigurationInput(input)
    const configure = () => configureManagedClis(
      parsed.intent === 'explicit' ? explicitProvisioning : automaticProvisioning,
      service,
      parsed.providers,
      parsed.preferredModels,
      options.previewOnboarding,
      options.managedCliKeys,
      parsed.mode,
      parsed.intent,
      parsed.keepKeys,
    ).then((outcome) => {
      logManagedCliFailures(outcome)
      return outcome
    })
    if (parsed.mode !== 'reset') return configure()
    return (async () => {
      for (const provider of parsed.providers) await backupBeforeReset(provider)
      return configure()
    })()
  })
  // Marks the keys a tool on this machine is using right now, so the keys page
  // can warn before revoking one and put a fresh key back afterwards. "Using"
  // means the key this app issued for that tool AND the tool's config still
  // holds exactly it: a cached key the user has since replaced is not in use.
  // Only the provider id crosses IPC, never the secret (I3). A display hint:
  // any failure degrades to the unmarked list, the pre-existing behavior.
  const markKeysInUse = async (page: AccountKeysPage, userId: number | undefined): Promise<AccountKeysPage> => {
    if (!userId || !options.managedCliKeys || options.previewOnboarding) return page
    const cached = await options.managedCliKeys.read(userId).catch(() => [])
    if (accountService.getSessionState().account?.userId !== userId) return page
    const inUse = new Map<number, ProviderId>()
    for (const entry of cached) {
      // 下线工具不再算星芒管的，它那把 Key 在密钥页上不标「在用」，也就不读它的配置。
      if (isRetiredProviderId(entry.provider)) continue
      let configured = ''
      try { configured = service.revealApiKey(entry.provider, options.previewOnboarding) } catch { continue }
      if (configured && configured === entry.key) inUse.set(entry.id, entry.provider)
    }
    if (!inUse.size) return page
    return {
      ...page,
      keys: page.keys.map((key) => {
        const managedProvider = inUse.get(key.id)
        return managedProvider ? { ...key, managedProvider } : key
      }),
    }
  }
  registerTrustedHandler('account:list-keys', (_event, input: unknown) => {
    const { keyword, ...query } = parseAccountKeysQuery(input)
    const userId = accountService.getSessionState().account?.userId
    const listed = keyword
      ? searchAccountKeys((pageQuery) => accountService.listKeys(pageQuery), keyword, query.page ?? 1, query.pageSize ?? 20)
      : accountService.listKeys(query)
    return listed.then((page) => markKeysInUse(page, userId))
  })
  registerTrustedHandler('account:list-groups', () => accountService.listUsableGroups())
  registerTrustedHandler('account:revoke-key', async (_event, id: unknown) => {
    const keyId = parseAccountRevokeKeyId(id)
    const userId = accountService.getSessionState().account?.userId
    const limited = userId ? await limitedManagedKey(userId, keyId) : null
    // 先落盘再撤销：撤销成功后软件随时可能被关，换新那一步要能在下次打开时照着签。
    const slot = userId && limited ? replacementSlot(userId, limited.provider) : null
    if (slot && limited) {
      const { remainQuota, unlimitedQuota, expiredAt } = limited.key
      try {
        await keyReplacements.set(slot, { remainQuota, unlimitedQuota, expiredAt })
      } catch (error) {
        // 记录读坏了，稍后再试也没用：要先让用户亲手「重新写入密钥」清掉它（见
        // provisioningAccountService 的 explicit 分支）。
        if (error instanceof ManagedKeyReplacementUnreadableError) throw new Error(managedKeyReplacementUnreadableRevokeMessage)
        throw new Error('没能记下这把密钥的额度设置，先没撤销。请稍后再试。')
      }
    }
    try {
      await accountService.revokeKey(keyId)
    } catch (error) {
      // 撤销报错不等于没撤成：服务端可能撤了、只是回话丢了（#475）。只有在列表里
      // 还看得见这把 Key 时才确定没撤，删掉记下的限制；看不见或查不了就留着，
      // 换新时照抄，宁可多限一次也不悄悄放开。
      if (slot) {
        const stillThere = await findAccountKeyById((query) => accountService.listKeys(query), keyId)
          .then((key) => key !== null, () => false)
        if (stillThere) await keyReplacements.remove(slot).catch(() => undefined)
      }
      throw error
    }
    if (userId) await invalidateAccountKeyCaches(userId, keyId)
  })
  registerTrustedHandler('account:copy-key', async (_event, id: unknown) => {
    const key = await revealAccountKeySecret(id)
    await sensitiveClipboard.write(key)
  })
  registerTrustedHandler('account:reveal-key', (_event, id: unknown) => revealAccountKeySecret(id))
  registerTrustedHandler('account:list-key-models', async (_event, id: unknown) => {
    const userId = accountService.getSessionState().account?.userId
    if (!userId) throw new Error('请先登录星芒账号')
    const apiKey = await revealAccountKeySecret(id, userId)
    assertAccountSessionUser(userId)
    const models = await service.fetchAvailableModels(apiKey)
    assertAccountSessionUser(userId)
    return models
  })
  registerTrustedHandler('account:configure-cli-with-key', async (_event, input: unknown) => {
    const parsed = parseAccountKeyCliConfigurationInput(input)
    const userId = accountService.getSessionState().account?.userId
    if (!userId) throw new Error('请先登录星芒账号')
    const apiKey = await revealAccountKeySecret(parsed.keyId, userId)
    assertAccountSessionUser(userId)
    const models = await service.fetchAvailableModels(apiKey)
    assertAccountSessionUser(userId)
    if (!models.includes(parsed.model)) throw new Error('所选密钥当前不支持该模型，请重新检测')
    if (parsed.mode === 'reset') await backupBeforeReset(parsed.provider)
    const result = await service.saveConfig({
      provider: parsed.provider,
      apiKey,
      model: parsed.model,
      mode: parsed.mode,
    }, options.previewOnboarding, () => assertAccountSessionUser(userId), { source: 'account', automatic: false })
    assertAccountSessionUser(userId)
    return result
  })
  registerTrustedHandler('account:create-key', (_event, input: unknown) => (
    accountService.createKey(parseAccountKeyCreateInput(input, accountService.getActiveSiteId?.() === 'solov-api'))
  ))
  registerTrustedHandler('account:update-key', async (_event, input: unknown) => {
    const parsed = parseAccountKeyUpdateInput(input, accountService.getActiveSiteId?.() === 'solov-api')
    const userId = accountService.getSessionState().account?.userId
    await accountService.updateKey(parsed)
    if (userId) await invalidateAccountKeyCaches(userId, parsed.id)
  })
  registerTrustedHandler('account:get-key-options', (_event, provider: unknown) => {
    // 入参校验必须同步抛出，所以这里不把整个 handler 改成 async。
    if (!isActiveProviderId(provider)) throw new Error('未知的 CLI 类型')
    // 分组在进入 resolveAccountKeyOptions 之前读好：那里从捕获账号快照到第一次
    // 落盘读取必须保持同步，中间插一次网络等待会把账号切换的判定窗口拉宽。
    return (async () => {
      const managedCliGroups = accountService.getSessionState().authenticated
        ? await loadManagedCliGroups(automaticProvisioning)
        : null
      return resolveAccountKeyOptions({ provider, systemService: service, accountService,
        managedCliKeys: options.managedCliKeys,
        chatKeyStore: options.chatKeyStore?.read ? { read: (userId) => options.chatKeyStore!.read!(userId) } : undefined,
        managedCliGroups,
        previewOnboarding: options.previewOnboarding })
    })()
  })
}

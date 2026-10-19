// 主窗口业务通道的处理器：账号登录退出、会话、本机记着的账号、公告、注册与找回密码、改密码、记住密码、登录设备。
// #1070 第 7 步从 ipc.ts 原样搬来：按域一个文件，ipc.ts 只管组装，各域共用的东西在 context.ts。
import { savedAccountId } from '../../saved-accounts'
import { parseLocalNoticeReadSync } from '../../announcement-read-store'
import { resolveRelaySite } from '../../relay-sites'
import { validateLoginSessionId, NewApiTwoFactorExpiredError } from '../../new-api-client'
import type { RelayBackendClient } from '../../relay-backend'
import { normalizeRealmLoginIdentifier } from '../../realm-account-vault'
import { realmForExplicitSite } from '../../realm-account'
import { clearXingmangAiSkillSecrets } from '../../xingmang-ai-skill'
import type { AccountSessionState } from '../../ipc-contract'
import { isRecord } from '../../input-guards'
import { requiredString } from '../parsers/common'
import {
  parseAccountChangePasswordInput,
  parseAccountDisplayNameUpdateInput,
  parseAccountEmailInput,
  parseAccountLoginInput,
  parseAccountPasswordResetInput,
  parseAccountRegisterInput,
  parseAccountSiteId,
  parseLegalDocumentKind,
  parseRememberedAccountLogin,
  parseResetPasswordToCopy,
  parseTwoFactorCode,
} from '../parsers/account'
import type { IpcHandlerContext } from './context'

export function registerAccountHandlers(ctx: IpcHandlerContext): void {
  const {
    options, registerTrustedHandler, startupGate, accountSessionReady, service, accountService,
    sensitiveClipboard,
  } = ctx
  registerTrustedHandler('account:get-status', (_event, siteId: unknown) => (
    options.realmAccounts && siteId !== undefined
      ? options.realmAccounts.getPublicClient(parseAccountSiteId(siteId)).getStatus()
      : accountService.getStatus()
  ))
  registerTrustedHandler('account:get-notice', (_event, mode: unknown) => {
    if (mode !== undefined && mode !== 'cached') throw new Error('公告读取方式无效')
    return accountService.getNotice?.(mode) ?? null
  })
  registerTrustedHandler('account:mark-notice-read', (_event, id: unknown, entryId: unknown) => {
    const noticeId = requiredString(id, '公告 ID', 128)
    if (typeof entryId !== 'string' || !/^[1-9]\d{0,15}$/.test(entryId) || !Number.isSafeInteger(Number(entryId))) {
      throw new Error('公告条目 ID 格式错误')
    }
    return accountService.markNoticeRead?.(noticeId, entryId)
  })
  registerTrustedHandler('account:sync-local-notice-reads', async (_event, scope: unknown, ids: unknown) => {
    const input = parseLocalNoticeReadSync(scope, ids)
    const revision = accountService.getSessionRevision?.()
    const assertCurrentAccount = () => {
      const state: AccountSessionState = accountService.getSessionState()
      if (accountService.getSessionRevision?.() !== revision || !state.authenticated
        || !Number.isSafeInteger(state.account?.userId)
        || state.siteId === 'solov-api' || state.realmId === 'api-account'
        || options.realmAccounts?.getSiteId() === 'solov-api'
        || input.scope !== `xm-account:${state.account?.userId}`) {
        throw new Error('公告账号上下文已变化，请重新打开公告')
      }
    }
    assertCurrentAccount()
    if (!options.announcementReads) throw new Error('公告已读记录保存服务暂不可用，请更新或重启软件')
    const result = await options.announcementReads.sync(input.scope, input.ids)
    assertCurrentAccount()
    return result
  })
  registerTrustedHandler('account:get-legal-document', (_event, kind: unknown, siteId: unknown) => (
    (options.realmAccounts ? options.realmAccounts.getPublicClient(siteId === undefined
      ? options.realmAccounts.getSiteId() : parseAccountSiteId(siteId)) : accountService).getLegalDocument(parseLegalDocumentKind(kind))
  ))
  registerTrustedHandler('account:login', async (_event, input: unknown) => {
    const parsed = parseAccountLoginInput(input)
    const siteId = isRecord(input) && input.siteId !== undefined ? parseAccountSiteId(input.siteId) : undefined
    if (!options.realmAccounts) {
      if (siteId !== undefined && siteId !== 'solov') throw new Error('当前账号服务不支持该账号来源')
      return accountService.login(parsed)
    }
    await accountSessionReady
    return options.realmAccounts.login({ ...parsed, siteId })
  })
  registerTrustedHandler('account:submit-two-factor-code', async (_event, code: unknown) => {
    const parsed = parseTwoFactorCode(code)
    // 待验证的登录只由账号服务那一层保管；没有它就没有可接的第二步。
    if (!options.realmAccounts) throw new NewApiTwoFactorExpiredError()
    await accountSessionReady
    return options.realmAccounts.completeTwoFactorLogin(parsed)
  })
  registerTrustedHandler('account:logout', async () => {
    options.chatService?.cancelAll()
    options.imageService?.cancelAll()
    options.paymentWindow.destroy()
    const result = await (options.realmAccounts ? options.realmAccounts.logout() : accountService.logout())
    if (options.xingmangAiSkill) {
      await clearXingmangAiSkillSecrets(options.xingmangAiSkill.userHome).catch((error) => {
        options.runtimeLog.log(
          'warn',
          'account',
          'xingmang-ai-skill.clear',
          error instanceof Error ? error.message : '星芒AI Skill 配置清理失败',
        )
      })
    }
    return result
  })
  registerTrustedHandler('account:get-session', async () => {
    // Guaranteed not to reject (see the option's own doc comment), but a
    // stray .catch() here costs nothing and means a future regression there
    // degrades to "restore didn't happen" instead of an unhandled rejection.
    await (startupGate?.released ?? accountSessionReady).catch(() => undefined)
    const state = accountService.getSessionState()
    if (!startupGate?.pending()) return state
    return { ...state, restoring: { account: startupGate.restoringAccount() } }
  })
  const accountOrigin = () => new URL(resolveRelaySite(service.readStoredConfig().relaySiteId).accountBaseUrl!).origin
  registerTrustedHandler('account:list-saved', async () => {
    await accountSessionReady.catch(() => undefined)
    if (options.realmAccounts) return options.realmAccounts.listSavedAccounts()
    const accounts = await options.savedAccounts?.list() ?? []
    return accounts.filter((account) => account.origin === accountOrigin()).map(({ id, origin, userId, username, updatedAt }) => ({ id, origin, userId, username, updatedAt }))
  })
  let switchingSavedAccount: Promise<ReturnType<RelayBackendClient['getSessionState']>> | null = null
  let switchingSavedAccountId: string | null = null
  registerTrustedHandler('account:switch-saved', (_event, idInput: unknown) => {
    const id = requiredString(idInput, '已保存账号标识', 64)
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('已保存账号标识无效')
    if (options.realmAccounts) return accountSessionReady.then(() => options.realmAccounts!.switchSavedAccount(id))
    if (switchingSavedAccount) {
      if (switchingSavedAccountId === id) return switchingSavedAccount
      throw new Error('正在切换账号，请稍后重试')
    }
    switchingSavedAccountId = id
    switchingSavedAccount = (async () => {
      await accountSessionReady.catch(() => undefined)
      const previous = accountService.getSessionState()
      const previousRevision = accountService.getSessionRevision?.()
      const previousOrigin = accountOrigin()
      if (previous.authenticated && previous.account && savedAccountId(previousOrigin, previous.account.userId) === id) return previous
      if (!options.savedAccounts || !accountService.switchSession) throw new Error('当前账号服务不支持本机账号切换')
      const candidate = await options.savedAccounts.getSession(id, previousOrigin)
      const current = accountService.getSessionState()
      if (accountOrigin() !== previousOrigin || (previousRevision !== undefined
        ? accountService.getSessionRevision?.() !== previousRevision
        : current.authenticated !== previous.authenticated || current.account !== previous.account)) {
        throw new Error('账号已切换，本次切换请求已失效，请重试')
      }
      if (!candidate) throw new Error('账号记录已不存在，请重新登录')
      if (!await accountService.switchSession(candidate)) throw new Error('目标账号登录已过期，当前账号已保留，请重新登录目标账号')
      if (previous.authenticated && previous.account) {
        options.chatService?.cancelUser(previous.account.userId)
        options.imageService?.cancelUser(previous.account.userId)
      }
      options.paymentWindow.destroy()
      return accountService.getSessionState()
    })().finally(() => { switchingSavedAccount = null; switchingSavedAccountId = null })
    return switchingSavedAccount
  })
  registerTrustedHandler('account:remove-saved', async (_event, idInput: unknown) => {
    const id = requiredString(idInput, '已保存账号标识', 64)
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('已保存账号标识无效')
    if (options.realmAccounts) { await options.realmAccounts.removeSavedAccount(id); return }
    const current = accountService.getSessionState()
    if (current.account && savedAccountId(accountOrigin(), current.account.userId) === id) throw new Error('请先退出当前账号，再移除本机记录')
    if (switchingSavedAccountId === id) throw new Error('正在切换此账号，请稍后重试')
    await options.savedAccounts?.remove(id)
  })
  registerTrustedHandler('account:register', (_event, input: unknown) => (
    accountService.register(parseAccountRegisterInput(input))
  ))
  registerTrustedHandler('account:send-verification-code', (_event, email: unknown) => (
    accountService.sendEmailVerification(parseAccountEmailInput(email))
  ))
  const passwordResetSiteId = (siteInput: unknown) => (
    siteInput === undefined ? options.realmAccounts?.getSiteId() ?? 'solov' : parseAccountSiteId(siteInput)
  )
  const passwordResetClient = (siteInput: unknown) => {
    const siteId = passwordResetSiteId(siteInput)
    if (!options.realmAccounts && siteId !== 'solov') throw new Error('当前账号服务不支持该账号来源')
    const client = options.realmAccounts?.getPublicClient(siteId) ?? accountService
    if (client.capabilities?.supportsPasswordReset === false) throw new Error('所选账号暂不支持在客户端找回密码，请前往对应账号官网')
    return client
  }
  registerTrustedHandler('account:send-reset-code', (_event, email: unknown, siteId: unknown) => (
    passwordResetClient(siteId).sendPasswordResetEmail(parseAccountEmailInput(email))
  ))
  const rememberedLoginStore = (siteId: 'solov' | 'solov-api') => (
    options.accountCredentialsForSite?.(siteId) ?? (siteId === 'solov' ? options.accountCredentials : undefined)
  )
  // Whether the identifier kept by 记住密码 names this account. The typed
  // identifier may be the username or the email (new-api accepts either), so
  // the username alone cannot tell; the vault's login hints record which
  // account each identifier actually signed in. Anything unprovable is "no":
  // rewriting or clearing another account's remembered login is worse than
  // leaving a stale one.
  const rememberedLoginNamesAccount = async (
    siteId: 'solov' | 'solov-api',
    identifier: string,
    account: { userId: number | string, username?: string },
  ): Promise<boolean> => {
    const normalized = normalizeRealmLoginIdentifier(identifier)
    if (account.username && normalizeRealmLoginIdentifier(account.username) === normalized) return true
    const owner = await options.realmAccounts?.loginHintOwner(normalized)
    return Boolean(owner && owner.realmId === realmForExplicitSite(siteId) && owner.userId === String(account.userId))
  }
  // The password change / reset already succeeded by the time these run, so
  // they never throw: a failure here must not turn a successful change into an
  // error toast. Neither logs anything -- the stored value is a password (I3).
  const replaceRememberedPassword = async (
    siteId: 'solov' | 'solov-api',
    account: { userId: number, username: string },
    password: string,
  ): Promise<void> => {
    const store = rememberedLoginStore(siteId)
    const remembered = await store?.read().catch(() => null)
    if (!store || !remembered) return
    const matches = await rememberedLoginNamesAccount(siteId, remembered.identifier, account).catch(() => false)
    if (!matches) return
    await store.save(remembered.identifier, password).catch(() => store.clear().catch(() => undefined))
  }
  const forgetRememberedPassword = async (siteId: 'solov' | 'solov-api', email: string): Promise<void> => {
    const store = rememberedLoginStore(siteId)
    const remembered = await store?.read().catch(() => null)
    if (!store || !remembered) return
    const matches = await (async () => {
      if (normalizeRealmLoginIdentifier(remembered.identifier) === normalizeRealmLoginIdentifier(email)) return true
      const owner = await options.realmAccounts?.loginHintOwner(email)
      return Boolean(owner && owner.realmId === realmForExplicitSite(siteId)
        && await rememberedLoginNamesAccount(siteId, remembered.identifier, { userId: owner.userId }))
    })().catch(() => false)
    if (matches) await store.clear().catch(() => undefined)
  }
  registerTrustedHandler('account:reset-password', (_event, input: unknown, siteInput: unknown) => {
    const parsed = parseAccountPasswordResetInput(input)
    const siteId = passwordResetSiteId(siteInput)
    // The reset hands back a one-time server-generated password the user is
    // about to replace, so it is not worth remembering; the old one is wrong.
    return passwordResetClient(siteInput).resetPassword(parsed).then(async (result) => {
      await forgetRememberedPassword(siteId, parsed.email)
      return result
    })
  })
  registerTrustedHandler('account:get-profile', () => accountService.getProfile())
  registerTrustedHandler('account:update-display-name', (_event, input: unknown) => (
    accountService.updateDisplayName(parseAccountDisplayNameUpdateInput(input))
  ))
  registerTrustedHandler('account:copy-reset-password', async (_event, value: unknown) => {
    sensitiveClipboard.write(parseResetPasswordToCopy(value))
  })
  registerTrustedHandler('account:change-password', (_event, input: unknown) => {
    const parsed = parseAccountChangePasswordInput(input, accountService.getActiveSiteId?.() === 'solov-api')
    // Captured before the call: a successful change can end the session, and
    // the remembered login must follow the account that changed, not whatever
    // is signed in afterwards.
    const siteId = options.realmAccounts?.getSiteId() ?? 'solov'
    const account = accountService.getSessionState().account
    return accountService.changePassword(parsed).then(async (result) => {
      if (account) await replaceRememberedPassword(siteId, account, parsed.newPassword)
      return result
    })
  })
  registerTrustedHandler('account:list-login-sessions', () => accountService.listLoginSessions())
  registerTrustedHandler('account:revoke-login-session', async (_event, sid: unknown) => {
    const result = await accountService.revokeLoginSession(
      validateLoginSessionId(requiredString(sid, '登录会话 ID', 64)),
    )
    if (result.current) {
      options.chatService?.cancelAll()
      options.imageService?.cancelAll()
      options.paymentWindow.destroy()
    }
    return result
  })
  registerTrustedHandler('account:revoke-other-login-sessions', () => (
    accountService.revokeOtherLoginSessions()
  ))
  registerTrustedHandler('account:get-remembered-login', async (_event, siteInput: unknown) => {
    const explicitSite = siteInput === undefined ? undefined : parseAccountSiteId(siteInput)
    if (options.realmAccounts) await accountSessionReady
    const hint = !explicitSite && options.realmAccounts ? await options.realmAccounts.latestLoginHint() : null
    const siteId = explicitSite ?? (hint ? (hint.realmId === 'api-account' ? 'solov-api' : 'solov')
      : options.realmAccounts?.getSiteId() ?? 'solov')
    const store = rememberedLoginStore(siteId)
    const remembered = await store?.read() ?? null
    if (remembered && hint && normalizeRealmLoginIdentifier(remembered.identifier) !== hint.identifier) return null
    // Re-shape to exactly the contract DTO -- the persisted record carries a
    // version field that has no business crossing IPC.
    return remembered ? { identifier: remembered.identifier, password: remembered.password } : null
  })
  registerTrustedHandler('account:set-remembered-login', async (_event, input: unknown, siteInput: unknown) => {
    const siteId = siteInput === undefined ? options.realmAccounts?.getSiteId() ?? 'solov' : parseAccountSiteId(siteInput)
    const parsed = parseRememberedAccountLogin(input)
    const store = rememberedLoginStore(siteId)
    if (!store) return
    if (parsed) {
      await store.save(parsed.identifier, parsed.password)
    } else {
      await store.clear()
    }
  })
}

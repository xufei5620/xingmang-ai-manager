// 主窗口业务通道各域处理器共用的那一份上下文：注册函数、系统服务和账号服务，以及账号、密钥、备份上
// 几个域都要用的小工具（#1070 第 7 步从 ipc.ts 原样搬来）。
import { clipboard, type IpcMainInvokeEvent } from 'electron'
import os from 'node:os'
import { apiKeyDigest, type ConfigBackupAccountContext } from '../../backups'
import { cliCatalog, providerIds, resolveManagedCliKeyProfiles, type ProviderId } from '../../catalog'
import {
  inheritedKeySettings,
  inheritedKeyExpiredMessage,
  isUsedUpKeyLimit,
  managedKeyQuotaExhaustedMessage,
} from '../../account-key-quota'
import { createMemoryManagedKeyReplacementStore, type ManagedKeyReplacementStore } from '../../managed-key-replacement-store'
import { configureManagedClis, type ManagedCliConfigurationOutcome, type ManagedCliKeyStoreLike } from '../../account-cli-provisioner'
import { requestDiagnosticsOf } from '../../request-diagnostics'
import { redactHomeDirectory } from '../../startup-log'
import type { SystemService } from '../../system-service'
import { createNewApiClient } from '../../new-api-client'
import type { RelayBackendClient } from '../../relay-backend'
import type { IpcInvokeChannel } from '../../ipc-channel-policy'
import { createExternalShellLauncher, type ExternalShellLauncher } from '../../system-shell'
import type { AccountStartupGate } from '../../account-startup-gate'
import { createSensitiveClipboard, type SensitiveClipboard } from '../../sensitive-clipboard'
import { parseAccountRevokeKeyId } from '../parsers/account-keys'
import type { IpcRegistrationOptions } from '../../ipc'
import type { DetectionFailureLogLine } from './detection-failures'
import type { CodexRemoteService } from '../../codex-remote-service'

const MAX_REMEMBERED_EXPORTS = 16

export type TrustedIpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

export type ManagedCliProvisioningService = Parameters<typeof configureManagedClis>[0]

/**
 * 各域处理器拿到的全部东西。只有 options 和这里列的几样，域文件之间不互相 import：一个域要用的
 * 东西如果别的域也要用，就放到这里来。
 */
export interface IpcHandlerContext {
  options: IpcRegistrationOptions
  /**
   * ipc.ts 里那一份包装：校验发送方页面、按 ipc-channel-policy.ts 那张表记日志和等账号（I4）。
   * 通道名只能是契约里的，拼错是编译错；每条通道注册一次，ipc.test.ts 拿实际注册的和契约对账。
   */
  registerTrustedHandler(channel: IpcInvokeChannel, handler: TrustedIpcHandler): void
  startupGate: AccountStartupGate | undefined
  /** 开机恢复账号那一下结束（成功失败都算）；options.accountSessionReady 没给就是已经结束。 */
  accountSessionReady: Promise<void>
  service: SystemService
  /** options.accountService 没给时是这里现建的那一个，各域共用同一个。 */
  accountService: RelayBackendClient
  externalShell: ExternalShellLauncher
  sensitiveClipboard: SensitiveClipboard
  /** 最近几次导出写出来的文件；「打开所在位置」只认这里面的。 */
  exportedFiles: readonly string[]
  rememberExportedFile(filePath: string): void
  logDetectionFailures(lines: DetectionFailureLogLine[]): void
  invalidateAccountKeyCaches(userId: number, keyId: number): Promise<void>
  keyReplacements: ManagedKeyReplacementStore
  replacementSlot(userId: number, provider: ProviderId): string
  logManagedCliFailures(outcome: ManagedCliConfigurationOutcome): void
  /** 自动签发：读不到撤销时记下的额度设置就停下。 */
  automaticProvisioning: ManagedCliProvisioningService
  /** 用户亲手点的「重新写入密钥」：读坏的额度记录可以清掉再签。 */
  explicitProvisioning: ManagedCliProvisioningService
  currentBackupAccountId(): string | null
  readBackupAccountContext(): Promise<ConfigBackupAccountContext | null>
  backupBeforeReset(provider: ProviderId): Promise<void>
  assertAccountSessionUser(expectedUserId: number): void
  revealAccountKeySecret(id: unknown, expectedUserId?: number): Promise<string>
  /** 手机遥控的底座；main.ts 还没建好（或测试没给）时抛一句能上屏的话。飞书、微信两边的处理器共用。 */
  codexRemote(): CodexRemoteService
}

/**
 * 每次 registerIpcHandlers 建一份。下面这些原来都是 registerIpcHandlers 的局部变量，函数体原样搬来，
 * 建的先后也照旧。
 */
export function createIpcHandlerContext(
  base: Pick<IpcHandlerContext, 'options' | 'registerTrustedHandler' | 'startupGate' | 'accountSessionReady'>,
): IpcHandlerContext {
  const { options } = base
  const externalShell = options.externalShell ?? createExternalShellLauncher()
  // 密钥和新密码 60 秒后自动从剪贴板清掉（第十三批 8）。
  const sensitiveClipboard = options.sensitiveClipboard ?? createSensitiveClipboard({ clipboard })
  // 最近几次导出写出来的文件：「打开所在位置」只认这里面的路径。
  const exportedFiles: string[] = []
  const rememberExportedFile = (filePath: string) => {
    const existing = exportedFiles.indexOf(filePath)
    if (existing >= 0) exportedFiles.splice(existing, 1)
    exportedFiles.push(filePath)
    if (exportedFiles.length > MAX_REMEMBERED_EXPORTS) exportedFiles.shift()
  }
  const service = options.systemService
  const accountService = options.accountService ?? createNewApiClient()
  const invalidateAccountKeyCaches = async (userId: number, keyId: number): Promise<void> => {
    const invalidations = [
      ...(options.managedCliKeys ? [{
        cache: 'managed-cli',
        run: () => options.managedCliKeys!.remove(userId, keyId),
      }] : []),
      ...(options.chatKeyStore ? [{
        cache: 'ai-chat',
        run: () => options.chatKeyStore!.removeByKeyId(userId, keyId),
      }] : []),
    ]
    const results = await Promise.allSettled(invalidations.map(async (entry) => entry.run()))
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') return
      options.runtimeLog.exception(
        'account',
        'key-cache-invalidation-failed',
        result.reason,
        { userId, keyId, cache: invalidations[index].cache },
      )
    })
  }
  // 撤销一把工具正在用、又设了限制的 Key 时把限制落盘，换上的新 Key 照抄（见
  // inheritedKeySettings）；换新成功再删。读不到这份记录就停下，不签不限额的。
  const keyReplacements = options.keyReplacements ?? createMemoryManagedKeyReplacementStore()
  const replacementSlot = (userId: number, provider: ProviderId): string => (
    `${accountService.getActiveSiteId?.() ?? 'solov'}:${userId}:${provider}`
  )
  // 写 Key（account:configure-managed-clis，以及切到当前账号）时没配上的工具是当结果交回界面的，写 Key
  // 的通道成功时又不记日志，所以以前一个字都不进日志：客户说「Key 配不上」，客服只看得到首页那句兜底话
  // （0.2.18 真机 19 号第 6 条）。这里每个没配上的工具记一条：哪家、原话、走的线路、服务器回的状态码和
  // 请求编号。原话是给客户看的那句，签 Key、查模型两处都已去掉 Key 和令牌；写配置失败的原话可能带配置
  // 文件的绝对路径，进日志前把主目录换掉（I13）。
  const logManagedCliFailures = (outcome: ManagedCliConfigurationOutcome): void => {
    const home = options.providerRoots?.userHome ?? os.homedir()
    for (const entry of outcome.failed) {
      const request = requestDiagnosticsOf(entry)
      options.runtimeLog.log('warn', 'account', 'managed-cli.key-failed',
        `${cliCatalog[entry.provider].name} 的 Key 没配上：${redactHomeDirectory(entry.message, home)}`, {
          provider: entry.provider,
          ...(entry.serviceUnavailable ? { serviceUnavailable: true } : {}),
          ...(request ? { request } : {}),
        })
    }
  }
  // explicit：用户亲手点的「重新写入密钥」「再换一次」。只有这一种能越过读坏的记录。
  const provisioningAccountService = (explicit: boolean): Parameters<typeof configureManagedClis>[0] => ({
    getSessionState: accountService.getSessionState.bind(accountService),
    getSessionRevision: accountService.getSessionRevision?.bind(accountService),
    getActiveSiteId: accountService.getActiveSiteId?.bind(accountService),
    listUsableGroups: accountService.listUsableGroups.bind(accountService),
    getSubscriptionSelf: accountService.getSubscriptionSelf.bind(accountService),
    listKeys: accountService.listKeys.bind(accountService),
    ...(options.accountGroupHints ? { getAccountGroupHints: options.accountGroupHints } : {}),
    ...(options.peekAccountGroupHints ? { peekAccountGroupHints: options.peekAccountGroupHints } : {}),
    ...(options.cliModelHints ? { getCliModelHints: options.cliModelHints } : {}),
    // 分组没了换组签了新密钥、新的已写进工具以后，删掉星芒签的旧那把（account-cli-provisioner.ts 的
    // retireReplacedKey，#1074）。删不掉照样往外抛，那边只当没删成。
    revokeKey: async (id: number) => {
      const userId = accountService.getSessionState().account?.userId
      try {
        await accountService.revokeKey(id)
      } catch (error) {
        options.runtimeLog.exception('account', 'managed-cli.old-key-revoke-failed', error, { keyId: id })
        throw error
      }
      options.runtimeLog.log('info', 'account', 'managed-cli.old-key-revoked', '分组没了，换上新密钥后删掉了星芒签的旧那把', { keyId: id })
      if (userId) await invalidateAccountKeyCaches(userId, id)
    },
    provisionCliKey: async (input = {}) => {
      const userId = accountService.getSessionState().account?.userId
      const siteId = accountService.getActiveSiteId?.()
      const profiles = resolveManagedCliKeyProfiles(siteId)
      const provider = providerIds.find((entry) => profiles[entry].keyName === input.name)
      if (!userId || !provider) return accountService.provisionCliKey(input)
      const slot = replacementSlot(userId, provider)
      let pending: Awaited<ReturnType<ManagedKeyReplacementStore['get']>>
      try {
        pending = await keyReplacements.get(slot)
      } catch {
        // 分不清原来有没有上限：自动签发一律停下说清楚；用户看过密钥页、亲手再点一次，
        // 才清掉坏记录照常签，免得以后每次都卡在这里。
        if (!explicit) {
          throw new Error('没读到这个工具原来的额度设置，这次没有自动签新密钥。到「个人中心 › 密钥管理」确认一下它的额度，再点「重新写入密钥」就会换上。')
        }
        await keyReplacements.reset().catch(() => undefined)
        pending = null
      }
      if (!pending) return accountService.provisionCliKey(input)
      let settings: ReturnType<typeof inheritedKeySettings>
      try {
        // Sub2API 的额度是金额、new-api 的是整数额度单位，各取后端允许的最小正数。
        settings = inheritedKeySettings(pending, siteId === 'solov-api' ? 0.01 : 1)
      } catch (error) {
        if (error instanceof Error && error.message === inheritedKeyExpiredMessage) {
          await keyReplacements.remove(slot).catch(() => undefined)
        }
        throw error
      }
      if (!settings) {
        await keyReplacements.remove(slot).catch(() => undefined)
        return accountService.provisionCliKey(input)
      }
      const replacement = await accountService.provisionCliKey({ ...input, ...settings, fresh: true })
      await keyReplacements.remove(slot).catch(() => undefined)
      // 上限原本就用完了：新 Key 签了（这样「按工具分账」里有一把可以调高的），但额度
      // 只有最小值，这里照直说，不当成换好了。
      if (isUsedUpKeyLimit(pending)) throw new Error(managedKeyQuotaExhaustedMessage)
      return replacement
    },
  })
  const automaticProvisioning = provisioningAccountService(false)
  const explicitProvisioning = provisioningAccountService(true)
  // 原话里常带着配置文件的绝对路径（I13）：进日志前把主目录换掉，同 config.ts 里切换来源那条日志。
  const logDetectionFailures = (lines: DetectionFailureLogLine[]) => {
    const home = options.providerRoots?.userHome ?? os.homedir()
    for (const line of lines) {
      const reason = line.reason ? redactHomeDirectory(line.reason, home) : '没有给出原因'
      options.runtimeLog.log('warn', 'system', line.event, `${line.name} 检测失败：${reason}`, line.detail)
    }
  }
  /**
   * 备份列表要标出每份备份里的 Key 是不是当前账号的。只读已有的 Key 缓存，从不
   * 签发、不联网；读不到（没登录 / 缓存打不开 / 读的期间换了账号）一律返回 null，
   * 列表退回「不标归属」的旧行为，而不是把所有备份都标成别人的。
   */
  function currentBackupAccountId(): string | null {
    const session = accountService.getSessionState()
    if (options.previewOnboarding || !session.authenticated || !session.account) return null
    const siteId = accountService.getActiveSiteId?.() ?? options.realmAccounts?.getSiteId() ?? 'solov'
    return JSON.stringify([siteId, session.account.userId, accountService.getSessionRevision?.() ?? null])
  }
  async function readBackupAccountContext(): Promise<ConfigBackupAccountContext | null> {
    const session = accountService.getSessionState()
    const account = session.account
    const identity = currentBackupAccountId()
    if (!identity || !account || !options.managedCliKeys) return null
    let keys: Awaited<ReturnType<ManagedCliKeyStoreLike['read']>>
    try { keys = await options.managedCliKeys.read(account.userId) } catch { return null }
    if (currentBackupAccountId() !== identity) return null
    const siteId = accountService.getActiveSiteId?.() ?? options.realmAccounts?.getSiteId() ?? 'solov'
    return {
      // 会话版本不进备份清单：重新登录同一个账号，旧备份仍认得是这个账号的。
      accountId: JSON.stringify([siteId, account.userId]),
      accountName: account.username,
      keyDigests: new Set(keys.map((entry) => apiKeyDigest(entry.key))),
    }
  }
  /**
   * 「重置为初始状态」答应过先备份。配置旁的 *.bak.<时间> 每个文件只留 5 份，每次在新
   * 文件夹打开工具写一次信任就挤掉一份，备份页也看不到它（全面检测 Q18）。所以重置前
   * 在备份页那套存储里留一份；留不下就不重置，免得用户以为还找得回来。四个重置入口都
   * 走这里：config:save、选的账号 Key、自动准备的 Key、官方账号（以前只有第一个留）；
   * 首页「配置文件坏了」的「修好它」走后两个。
   */
  async function backupBeforeReset(provider: ProviderId): Promise<void> {
    try {
      options.backupStore.create(provider, 'pre-save', undefined, await readBackupAccountContext())
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`没能先备份当前配置，这次没有重置：${reason}`)
    }
  }
  const assertAccountSessionUser = (expectedUserId: number): void => {
    const session = accountService.getSessionState()
    if (!session.authenticated || session.account?.userId !== expectedUserId) {
      throw new Error('账号会话已变更，请重试')
    }
  }
  const revealAccountKeySecret = async (id: unknown, expectedUserId?: number): Promise<string> => {
    const keyId = parseAccountRevokeKeyId(id)
    const startingSession = accountService.getSessionState()
    const userId = expectedUserId
      ?? (startingSession.authenticated ? startingSession.account?.userId : undefined)
    const assertStartingSessionIsCurrent = () => {
      if (!userId) return
      assertAccountSessionUser(userId)
    }
    assertStartingSessionIsCurrent()
    if (userId && options.managedCliKeys) {
      // Intentionally do not catch: a corrupt or unavailable encrypted cache
      // must not be mistaken for a cache miss and silently bypassed via HTTP.
      const cachedKeys = await options.managedCliKeys.read(userId)
      assertStartingSessionIsCurrent()
      const cached = cachedKeys.find((entry) => entry.id === keyId)
      if (cached) return cached.key
    }
    assertStartingSessionIsCurrent()
    const secret = await accountService.revealKey(keyId)
    assertStartingSessionIsCurrent()
    return secret
  }
  const codexRemote = (): CodexRemoteService => {
    if (!options.codexRemote) throw new Error('手机遥控暂未准备好，请稍后再试。')
    return options.codexRemote
  }
  return {
    ...base,
    codexRemote,
    externalShell,
    sensitiveClipboard,
    exportedFiles,
    rememberExportedFile,
    service,
    accountService,
    invalidateAccountKeyCaches,
    keyReplacements,
    replacementSlot,
    logManagedCliFailures,
    automaticProvisioning,
    explicitProvisioning,
    logDetectionFailures,
    currentBackupAccountId,
    readBackupAccountContext,
    backupBeforeReset,
    assertAccountSessionUser,
    revealAccountKeySecret,
  }
}

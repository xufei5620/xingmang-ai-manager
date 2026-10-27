// 星芒账号、历史账号两个站点的登录记录和账号客户端（#1070 第 5 步从 main.ts 的启动回调原样搬出）：
// 登录记录放在系统加密的保管里，账号请求按线路走、经系统代理没走通时改直连重发。换账号、退出时
// 各个服务怎么收拾（quiesce、onChanged）牵着整个应用，留在 main.ts。
import path from 'node:path'
import { type BrowserWindow, safeStorage } from 'electron'
import { AccountSessionStore } from '../account-session-store'
import { relayStatusProbeUrl } from '../diagnostics'
import { ipcEventChannels } from '../ipc-contract'
import { createNewApiClient, type NewApiRetryOffProxyFailure } from '../new-api-client'
import { parseRealmSavedAccount, type RealmSavedAccount } from '../realm-account'
import type { RealmAccountClientHandle, RealmAccountSiteId } from '../realm-account-service'
import { createSessionRealmAccountVault, type RealmAccountVault } from '../realm-account-vault'
import { createFileRealmAccountVault } from '../realm-account-vault-file'
import { requireRelaySite } from '../relay-sites'
import type { RuntimeLogStore } from '../runtime-log'
import { inspectSafeStorageBackend, resolveCredentialPersistence } from '../safe-storage-backend'
import { SavedAccountsStore } from '../saved-accounts'
import { createSub2ApiRelayBackend } from '../sub2api-relay-backend'
import { createVaultRecoveryNotifier } from '../vault-recovery-notice'
import type { NetworkRoutes } from './network-routes'

export interface AccountStorageOptions {
  managerDataDirectory: string
  runtimeLog: RuntimeLogStore
  /** Linux 上 ready 之前改用的系统密码保管（linux-password-store.ts），没改是 null。 */
  linuxPasswordStore: string | null
  /** 主窗口建得比这里晚，用到时再取。 */
  mainWindow: () => BrowserWindow | null
}

export function createAccountStorage(options: AccountStorageOptions) {
  const { managerDataDirectory, runtimeLog, linuxPasswordStore, mainWindow } = options
  // Both realms commit accounts through the OS-backed encrypted vault. When
  // encryption is unavailable, Windows and macOS reject login; Linux signs in
  // for this run only (resolveCredentialPersistence). Existing files are never
  // touched either way.
  const safeStorageBackend = inspectSafeStorageBackend(safeStorage)
  const credentialPersistence = resolveCredentialPersistence(process.platform, safeStorageBackend)
  if (linuxPasswordStore) {
    // The detail key avoids "password": the log sanitizer would redact the value.
    runtimeLog.log('info', 'account', 'session.password-store', '桌面环境不在 Chromium 认识的名单里，已改用系统自带的密码保管', {
      selectedStore: linuxPasswordStore,
      backend: safeStorageBackend,
    })
  }
  if (safeStorageBackend !== 'ok') {
    runtimeLog.log(
      'warn',
      'account',
      'session.persist.unavailable',
      credentialPersistence === 'session-only'
        ? '这台电脑没法安全保存登录，本次登录只留在内存里，关掉软件后要重新登录；已有账号文件不动'
        : '系统未提供安全加密存储，请恢复系统凭据服务后登录；已有账号文件将保留',
      { backend: safeStorageBackend, persistence: credentialPersistence },
    )
  }
  const accountSessionStore = new AccountSessionStore(path.join(managerDataDirectory, 'account-session.dat'), safeStorage)
  const savedAccounts = new SavedAccountsStore(path.join(managerDataDirectory, 'saved-accounts.dat'), safeStorage)
  const vault = credentialPersistence === 'session-only' ? createSessionRealmAccountVault() : createFileRealmAccountVault(managerDataDirectory, safeStorage, {
    // 重建之后用户看到的是「记住的账号没了」，只记日志等于让他自己猜，所以同时
    // 给界面发一条（一次启动只发一条，备份文件名不跟着走）。
    onRecovered: createVaultRecoveryNotifier({
      log: (backupFileName) => runtimeLog.log('warn', 'account', 'vault.recovered',
        '本地登录记录无法解密，已保留原密文备份并重建账号存储', { reason: 'decrypt', backupFileName }),
      emit: () => {
        const managedMainWindow = mainWindow()
        if (!managedMainWindow || managedMainWindow.isDestroyed()) return
        if (managedMainWindow.webContents.isDestroyed()) return
        managedMainWindow.webContents.send(ipcEventChannels.onAccountVaultRecovered, undefined)
      },
    }),
  })
  return { credentialPersistence, accountSessionStore, savedAccounts, vault }
}

export interface AccountClientFactoryOptions {
  vault: RealmAccountVault
  routes: Pick<NetworkRoutes, 'relayRouting' | 'proxyBypass' | 'routedAccountRelayFetch' | 'routedAccountFetch'>
  runtimeLog: RuntimeLogStore
}

/** 账号服务换站点、恢复登录时用它给每个站点建客户端（createRealmAccountService 的 createClient）。 */
export function createAccountClientFactory(options: AccountClientFactoryOptions) {
  const { vault, routes: { relayRouting, proxyBypass, routedAccountRelayFetch, routedAccountFetch }, runtimeLog } = options
  // 系统代理活着却不转发时（代理软件换了线路、规则把账号服务挡了），账号请求只会
  // 一直超时。客户端在网络层失败后来问这一句，和登没登录无关；所以兜底必须建在
  // 账号服务之前，开机恢复登录的头一个请求就用得上。
  // 改直连的是这个客户端连的站点：切账号时另一个站点的登录框也在发请求，它不一定是
  // 当前选中的那个。
  async function recoverAccountRequestOffProxy(siteId: RealmAccountSiteId, failure: NewApiRetryOffProxyFailure): Promise<boolean> {
    const siteProbeUrl = relayStatusProbeUrl(relayRouting.resolve(siteId))
    const retry = await proxyBypass.recoverFailedRequest(failure.startedAt, failure.reason, siteProbeUrl)
    if (retry) {
      // 直连那一路刚交还给系统代理、或者代理只断了一下又连得上时，重发走的是系统代理。
      const scope = proxyBypass.active() ? 'app' : proxyBypass.siteDirect() ? 'site' : 'proxy'
      runtimeLog.log('info', 'network', 'proxy-bypass.account-retry', scope !== 'proxy'
        ? '账号请求经系统代理没走通，已改直接联网'
        : failure.reason === 'proxy'
          ? '账号请求撞上系统代理断了一下，代理又连得上了，经系统代理重发'
          : '账号请求直接联网没走通，已改回跟随系统代理', {
        reason: failure.reason,
        method: failure.method,
        scope,
      })
    }
    return retry
  }
  function createClient(siteId: RealmAccountSiteId, onSessionChange: (account: RealmSavedAccount | null) => void): RealmAccountClientHandle {
    // 历史账号的客户端写死的是默认线路的地址（sub2api-relay-backend.ts 不改），走直连靠请求这一层换地址。
    if (siteId === 'solov-api') return createSub2ApiRelayBackend({ fetchImpl: routedAccountRelayFetch, onSessionChange,
      onCredentialRotation: (saved) => vault.updateSession(saved) })
    let client: ReturnType<typeof createNewApiClient>
    function saved(): RealmSavedAccount | null {
      const persisted = client.getPersistableSession()
      const profile = client.getSessionState().account
      return persisted && profile ? parseRealmSavedAccount({ version: 2, realmId: 'xm-account',
        origin: 'https://xm.solov.cc', userId: String(persisted.userId), username: profile.username,
        credential: { kind: 'new-api', cookies: persisted.cookies } }) : null
    }
    // 客户端认的一直是默认线路的地址（登录记录、凭据都按它记），这会儿走哪条线路由请求这一层换。
    client = createNewApiClient({ baseUrl: requireRelaySite(siteId).accountBaseUrl, fetchImpl: routedAccountFetch,
      retryOffProxy: (failure) => recoverAccountRequestOffProxy(siteId, failure),
      // 续期没等到回话、补续，和服务器不认这次登录：反馈报告里看得出客户为什么被退出来。
      log: (level, event, message, detail) => runtimeLog.log(level, 'account', event, message, { siteId, ...detail }),
      onCredentialRotation: async (persisted) => {
        const revision = client.getSessionRevision()
        const owner = { realmId: 'xm-account' as const, userId: String(persisted.userId) }
        const existing = await vault.get(owner)
        if (client.getSessionRevision() !== revision) throw new Error('账号会话已变更')
        if (existing) await vault.updateSession(parseRealmSavedAccount({ ...existing,
          credential: { kind: 'new-api', cookies: persisted.cookies } }))
      },
      onSessionChange: () => onSessionChange(saved()) })
    return { client, getSavedAccount: saved, restore: async (record) => {
      if (record.realmId !== 'xm-account' || record.credential.kind !== 'new-api') throw new Error('账号凭据与当前账号不匹配')
      return client.restoreSession({ userId: Number(record.userId), cookies: [...record.credential.cookies] })
    }, endSavedSession: async (record) => {
      if (record.realmId !== 'xm-account' || record.credential.kind !== 'new-api') return
      await client.endPersistedServerSession({ userId: Number(record.userId), cookies: [...record.credential.cookies] })
    } }
  }
  return createClient
}

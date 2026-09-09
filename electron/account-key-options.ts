import { isProviderId, resolveManagedCliKeyProfiles, type ProviderId } from './catalog'
import type { StoredChatKey } from './chat-key-store'
import type { StoredManagedCliKey } from './managed-cli-key-store'
import type { RelayBackendClient } from './relay-backend'
import { RealmAccountError } from './realm-account'
import type { SystemService } from './system-service'

export interface AccountKeyOptionsResult {
  current: { preview: string | null; keyId: number | null; name: string | null; group: string | null }
  automatic: { name: string; group: string }
}
export interface AccountKeyOptionsDependencies {
  provider: ProviderId
  systemService: Pick<SystemService, 'getConfig' | 'revealApiKey'>
  accountService: RelayBackendClient
  /** Supply the cache belonging to the active realm; records are indexed by user ID within it. */
  managedCliKeys?: { read(userId: number): Promise<StoredManagedCliKey[]> }
  chatKeyStore?: { read(userId: number): Promise<StoredChatKey[]> }
  previewOnboarding: boolean
}
interface KeyMetadata { id: number; name: string; group: string }

function validMetadata(value: KeyMetadata, secret: string): boolean {
  return Number.isSafeInteger(value.id) && value.id > 0
    && typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 128
    && typeof value.group === 'string' && value.group.length > 0 && value.group.length <= 128
    && !/[\u0000-\u001f\u007f]/.test(value.name + value.group)
    && !value.name.includes(secret) && !value.group.includes(secret)
}

/** Resolve the installed key's real group without returning/revealing the secret over IPC. */
export async function resolveAccountKeyOptions(options: AccountKeyOptionsDependencies): Promise<AccountKeyOptionsResult> {
  if (!isProviderId(options.provider)) throw new RealmAccountError('INVALID')
  const service = options.accountService
  const siteId = service.getActiveSiteId?.() ?? 'solov'
  const profile = resolveManagedCliKeyProfiles(siteId)[options.provider]
  const configured = options.systemService.getConfig(options.previewOnboarding).providers[options.provider]
  const result: AccountKeyOptionsResult = {
    current: { preview: configured.apiKeyPreview, keyId: null, name: null, group: null },
    automatic: { name: profile.keyName, group: profile.group },
  }
  const session = service.getSessionState()
  if (!configured.hasApiKey || !configured.matchesRelay || !session.authenticated || !session.account) return result
  const userId = session.account.userId
  const revision = service.getSessionRevision?.()
  if (!Number.isSafeInteger(userId) || userId <= 0 || revision === undefined
    || !Number.isSafeInteger(revision) || revision < 0) throw new RealmAccountError('STALE')
  let secret: string | undefined
  function assertCurrent(): void {
    const current = service.getSessionState()
    if (!current.authenticated || current.account?.userId !== userId
      || service.getSessionRevision?.() !== revision || (service.getActiveSiteId?.() ?? 'solov') !== siteId) throw new RealmAccountError('STALE')
    if (secret !== undefined) {
      const local = options.systemService.getConfig(options.previewOnboarding).providers[options.provider]
      if (!local.hasApiKey || !local.matchesRelay
        || options.systemService.revealApiKey(options.provider, options.previewOnboarding) !== secret) throw new RealmAccountError('STALE')
      result.current.preview = local.apiKeyPreview
    }
  }
  async function owned<T>(operation: () => Promise<T>): Promise<T> {
    assertCurrent()
    try {
      const value = await operation()
      assertCurrent()
      return value
    } catch (error) {
      assertCurrent()
      // Cache/backend exceptions must never reflect an API Key supplied to
      // a provider's identification endpoint into an ordinary IPC error.
      if (error instanceof RealmAccountError) throw error
      throw new Error('无法读取当前 API Key 的所属分组，请重试')
    }
  }
  secret = options.systemService.revealApiKey(options.provider, options.previewOnboarding)
  assertCurrent()
  if (!secret) return result
  const matches: KeyMetadata[] = []
  if (options.managedCliKeys) {
    const cached = await owned(() => options.managedCliKeys!.read(userId))
    for (const entry of cached) {
      if (entry.key !== secret || !isProviderId(entry.provider)
        || entry.group !== resolveManagedCliKeyProfiles(siteId)[entry.provider].group) continue
      const candidate = { id: entry.id, name: entry.name, group: entry.group }
      if (validMetadata(candidate, secret)) matches.push(candidate)
    }
  }
  if (options.chatKeyStore) {
    const cached = await owned(() => options.chatKeyStore!.read(userId))
    for (const entry of cached) {
      if (entry.userId !== userId || entry.key !== secret) continue
      const candidate = { id: entry.keyId, name: entry.keyName, group: entry.group }
      if (validMetadata(candidate, secret)) matches.push(candidate)
    }
  }
  const distinct = new Map(matches.map((entry) => [JSON.stringify([entry.id, entry.name, entry.group]), entry]))
  // Contradicting exact matches are not evidence for either group. Do not
  // replace an ambiguous local record with a guess based on names or masks.
  if (distinct.size > 1) return result
  let identified = distinct.values().next().value as KeyMetadata | undefined
  if (service.identifyKey) {
    const capturedSecret = secret
    const remote = await owned(() => service.identifyKey!(capturedSecret))
    // An administrator can move an existing key to another group. Where
    // exact backend identification exists, its fresh metadata wins over a
    // local provisioning cache; a missing match is explicitly unknown.
    identified = remote && validMetadata(remote, secret) ? { id: remote.id, name: remote.name, group: remote.group } : undefined
  }
  assertCurrent()
  if (identified) result.current = { preview: result.current.preview, keyId: identified.id, name: identified.name, group: identified.group }
  return result
}

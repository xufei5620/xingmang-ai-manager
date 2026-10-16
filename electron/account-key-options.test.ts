import { describe, expect, it, vi } from 'vitest'
import { resolveAccountKeyOptions } from './account-key-options'
import { providerIds, resolveManagedCliKeyProfiles } from './catalog'
import type { AppConfigSummary } from './system-service'
import type { RelayBackendClient } from './relay-backend'
import type { StoredChatKey } from './chat-key-store'
import type { StoredManagedCliKey } from './managed-cli-key-store'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function fixture() {
  const state = { userId: 7, authenticated: true, revision: 1, siteId: 'solov-api' as 'solov' | 'solov-api',
    secret: 'sk-current-real-secret-1234', matchesRelay: true, hasApiKey: true }
  const managed: StoredManagedCliKey[] = []
  const chat: StoredChatKey[] = []
  const identifyKey = vi.fn(async (): Promise<{ id: number; name: string; group: string } | null> => null)
  const accountService = { getSessionState: () => ({ authenticated: state.authenticated,
    account: state.authenticated ? { userId: state.userId } : null }), getSessionRevision: () => state.revision,
    getActiveSiteId: () => state.siteId, identifyKey } as unknown as RelayBackendClient
  const systemService = {
    getConfig: vi.fn(() => ({ workspace: '', providers: Object.fromEntries(providerIds.map((id) => [id,
      { hasApiKey: state.hasApiKey, matchesRelay: state.matchesRelay, apiKeyPreview: state.hasApiKey ? 'sk-cu••••1234' : null }])) } as AppConfigSummary)),
    revealApiKey: vi.fn(() => state.secret),
  }
  const managedCliKeys = { read: vi.fn(async () => [...managed]) }
  const chatKeyStore = { read: vi.fn(async () => [...chat]) }
  const options = { provider: 'codex' as const, systemService, accountService, managedCliKeys, chatKeyStore, previewOnboarding: false }
  return { state, managed, chat, identifyKey, accountService, systemService, managedCliKeys, chatKeyStore, options }
}

describe('current and automatic account key options', () => {
  it('shows the actual current key group independently of the automatic provider profile', async () => {
    const f = fixture()
    f.accountService.identifyKey = undefined
    f.chat.push({ userId: 7, keyId: 29, keyName: 'user-selected-key', group: 'Gemini', key: f.state.secret })
    expect(await resolveAccountKeyOptions(f.options)).toEqual({
      current: { preview: 'sk-cu••••1234', keyId: 29, name: 'user-selected-key', group: 'Gemini' },
      automatic: { name: 'xingmang-desktop-codex', group: 'Codex_pro' },
    })
    expect(f.chatKeyStore.read).toHaveBeenCalledWith(7)
    expect(f.identifyKey).not.toHaveBeenCalled()
  })
  it('uses the selected realm automatic profile and accepts exact owned managed cache matches', async () => {
    for (const siteId of ['solov', 'solov-api'] as const) {
      const f = fixture()
      f.accountService.identifyKey = undefined
      f.state.siteId = siteId
      const profile = resolveManagedCliKeyProfiles(siteId).codex
      f.managed.push({ id: 3, provider: 'codex', name: profile.keyName, group: profile.group, key: f.state.secret })
      expect(await resolveAccountKeyOptions(f.options)).toMatchObject({ current: { keyId: 3, group: profile.group },
        automatic: { name: profile.keyName, group: profile.group } })
      expect(f.managedCliKeys.read).toHaveBeenCalledWith(7)
      expect(f.identifyKey).not.toHaveBeenCalled()
    }
  })
  it('does not identify a key by matching preview or suffix', async () => {
    const f = fixture()
    f.chat.push({ userId: 7, keyId: 1, keyName: 'spoofed', group: 'wrong', key: 'sk-current-different-secret-1234' })
    expect((await resolveAccountKeyOptions(f.options)).current).toEqual({ preview: 'sk-cu••••1234', keyId: null, name: null, group: null })
    expect(f.identifyKey).toHaveBeenCalledWith(f.state.secret)
  })
  it('never reads secrets or calls account identification for a third-party config', async () => {
    const f = fixture()
    f.state.matchesRelay = false
    const value = await resolveAccountKeyOptions(f.options)
    expect(value.current).toEqual({ preview: 'sk-cu••••1234', keyId: null, name: null, group: null })
    expect(f.systemService.revealApiKey).not.toHaveBeenCalled()
    expect(f.managedCliKeys.read).not.toHaveBeenCalled()
    expect(f.chatKeyStore.read).not.toHaveBeenCalled()
    expect(f.identifyKey).not.toHaveBeenCalled()
  })
  it('keeps installed preview but returns empty identity metadata while signed out', async () => {
    const f = fixture()
    f.state.authenticated = false
    expect((await resolveAccountKeyOptions(f.options)).current).toEqual({ preview: 'sk-cu••••1234', keyId: null, name: null, group: null })
    expect(f.systemService.revealApiKey).not.toHaveBeenCalled()
    expect(f.identifyKey).not.toHaveBeenCalled()
  })
  it('returns an empty current key when local configuration has no secret', async () => {
    const f = fixture()
    f.state.hasApiKey = false
    expect((await resolveAccountKeyOptions(f.options)).current).toEqual({ preview: null, keyId: null, name: null, group: null })
    expect(f.systemService.revealApiKey).not.toHaveBeenCalled()
  })
  it('rejects cached records for another user or another managed realm', async () => {
    const f = fixture()
    f.chat.push({ userId: 8, keyId: 1, keyName: 'foreign', group: 'Gemini', key: f.state.secret })
    f.managed.push({ provider: 'codex', id: 3, name: 'foreign', group: resolveManagedCliKeyProfiles('solov').codex.group, key: f.state.secret })
    expect((await resolveAccountKeyOptions(f.options)).current.keyId).toBeNull()
  })
  it('does not guess between conflicting exact matches or fall back to remote identification', async () => {
    const f = fixture()
    f.chat.push({ userId: 7, keyId: 1, keyName: 'one', group: 'Gemini', key: f.state.secret },
      { userId: 7, keyId: 2, keyName: 'two', group: 'Codex_pro', key: f.state.secret })
    expect((await resolveAccountKeyOptions(f.options)).current.group).toBeNull()
    expect(f.identifyKey).not.toHaveBeenCalled()
  })
  it('collapses duplicate identical matches from two owned caches', async () => {
    const f = fixture()
    f.accountService.identifyKey = undefined
    f.managed.push({ provider: 'codex', id: 3, name: 'shared', group: 'Codex_pro', key: f.state.secret })
    f.chat.push({ userId: 7, keyId: 3, keyName: 'shared', group: 'Codex_pro', key: f.state.secret })
    expect((await resolveAccountKeyOptions(f.options)).current.keyId).toBe(3)
    expect(f.identifyKey).not.toHaveBeenCalled()
  })
  it('uses main-only server identification for uncached keys and strips all extra fields', async () => {
    const f = fixture()
    f.identifyKey.mockResolvedValue({ id: 22, name: 'server-key', group: 'GPT-image2', key: f.state.secret } as { id: number; name: string; group: string })
    const value = await resolveAccountKeyOptions(f.options)
    expect(value.current).toEqual({ preview: 'sk-cu••••1234', keyId: 22, name: 'server-key', group: 'GPT-image2' })
    expect(JSON.stringify(value)).not.toContain(f.state.secret)
  })
  it('shows a remotely changed group instead of the old exact-key cache metadata', async () => {
    const f = fixture()
    f.managed.push({ provider: 'codex', id: 3, name: 'managed', group: 'Codex_pro', key: f.state.secret })
    f.identifyKey.mockResolvedValue({ id: 3, name: 'renamed', group: 'custom-current-group' })
    expect((await resolveAccountKeyOptions(f.options)).current).toEqual({ preview: 'sk-cu••••1234', keyId: 3, name: 'renamed', group: 'custom-current-group' })
    f.identifyKey.mockResolvedValue(null)
    expect((await resolveAccountKeyOptions(f.options)).current.group).toBeNull()
  })
  for (const change of ['user', 'realm', 'revision', 'logout'] as const) {
    it(`rejects a delayed cache result after ${change} changes`, async () => {
      const f = fixture()
      const gate = deferred<StoredManagedCliKey[]>()
      f.managedCliKeys.read.mockImplementationOnce(() => gate.promise)
      const pending = resolveAccountKeyOptions(f.options)
      if (change === 'user') f.state.userId = 8
      if (change === 'realm') f.state.siteId = 'solov'
      if (change === 'revision') f.state.revision++
      if (change === 'logout') f.state.authenticated = false
      gate.resolve([])
      await expect(pending).rejects.toMatchObject({ code: 'STALE' })
      expect(f.chatKeyStore.read).not.toHaveBeenCalled()
      expect(f.identifyKey).not.toHaveBeenCalled()
    })
  }
  it('replaces late cache errors with a stale identity error', async () => {
    const f = fixture()
    const gate = deferred<StoredManagedCliKey[]>()
    f.managedCliKeys.read.mockImplementationOnce(() => gate.promise)
    const pending = resolveAccountKeyOptions(f.options)
    f.state.revision++
    gate.reject(new Error('old account path'))
    await expect(pending).rejects.toMatchObject({ code: 'STALE' })
  })
  it('rejects a delayed server match after same-user re-login', async () => {
    const f = fixture()
    const gate = deferred<{ id: number; name: string; group: string } | null>()
    f.identifyKey.mockImplementationOnce(() => gate.promise)
    const pending = resolveAccountKeyOptions(f.options)
    await vi.waitFor(() => expect(f.identifyKey).toHaveBeenCalled())
    f.state.revision++
    gate.resolve({ id: 22, name: 'old', group: 'Gemini' })
    await expect(pending).rejects.toMatchObject({ code: 'STALE' })
  })
  for (const change of ['secret', 'relay', 'removed'] as const) it(`rejects a delayed result when local config ${change} changes without an account switch`, async () => {
    const f = fixture()
    const gate = deferred<StoredManagedCliKey[]>()
    f.managedCliKeys.read.mockImplementationOnce(() => gate.promise)
    const pending = resolveAccountKeyOptions(f.options)
    if (change === 'secret') f.state.secret = 'sk-new-local-config-1234'
    if (change === 'relay') f.state.matchesRelay = false
    if (change === 'removed') f.state.hasApiKey = false
    gate.resolve([])
    await expect(pending).rejects.toMatchObject({ code: 'STALE' })
    expect(f.identifyKey).not.toHaveBeenCalled()
  })
  it('does not echo key-bearing backend errors across IPC', async () => {
    const f = fixture()
    f.identifyKey.mockRejectedValue(new Error(`request failed for ${f.state.secret}`))
    await expect(resolveAccountKeyOptions(f.options)).rejects.toThrow('无法读取当前 API Key 的所属分组，请重试')
  })
})

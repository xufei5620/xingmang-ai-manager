import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppSettingsStore } from './app-settings'
import { providerBaseUrls } from './catalog'
import { saveProviderConfig } from './config-files'
import { createOfficialCredentialService, relayModelBeforeOfficialSwitch } from './official-credential-service'
import { relaySiteEndpointChoices, relaySites } from './relay-sites'
import type { SystemServiceOptions } from './system-service'
import { createServiceContext } from './system-service-context'

// #1070 第 3 步把官方账号来回切那一段搬成了 createOfficialCredentialService。切回官方、恢复备份对齐来源的全过程
// 仍由 system-service.test.ts、tool-config-ownership.test.ts 经 createSystemService 覆盖；这里钉住搬家新接上的那几处：
// 挪开和放回用的是上下文给的那份主目录，改官方记号排在上下文那条写配置的队里（保存配置也排这条），撤回失败时
// 把现在的状态补进报错。

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function createService(options: SystemServiceOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-official-credential-service-'))
  temporaryDirectories.push(root)
  const userHome = path.join(root, 'home')
  fs.mkdirSync(path.join(userHome, '.claude'), { recursive: true })
  const store = new AppSettingsStore(path.join(root, 'settings.json'), root)
  const context = createServiceContext(store, {
    platform: 'linux',
    managerDataDirectory: root,
    providerRoots: { userHome, codexHome: path.join(root, 'codex') },
    ...options,
  })
  return { context, store, userHome, roots: { userHome, codexHome: path.join(root, 'codex') }, service: createOfficialCredentialService(context) }
}

function readRootConfig(userHome: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(userHome, '.claude.json'), 'utf8')) as Record<string, unknown>
}

describe('official credential service', () => {
  it('moves the Claude Console key aside and puts it back under the context home', () => {
    const logged: string[] = []
    const { service, userHome } = createService({ runtimeLog: { log: (_level, _source, event) => { logged.push(event) } } })
    fs.writeFileSync(path.join(userHome, '.claude.json'), JSON.stringify({ primaryApiKey: 'sk-ant-fixture', theme: 'dark' }))

    expect(service.moveOfficialCredentialsAside()).toBe(true)
    expect(readRootConfig(userHome)).toEqual({ theme: 'dark' })
    expect(logged).toEqual(['official-credentials.moved'])

    expect(service.restoreOfficialCredentialsNow()).toBe(true)
    expect(readRootConfig(userHome)).toEqual({ theme: 'dark', primaryApiKey: 'sk-ant-fixture' })
  })

  it('waits for a config write already in the shared queue before changing the official flag', async () => {
    const { context, store, service } = createService()
    let releaseWrite!: () => void
    const pendingWrite = context.serializeConfigWrite(() => new Promise<void>((resolve) => { releaseWrite = resolve }))

    const flagged = service.setOfficialSourcePreference('claude', true)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(store.read().officialProviders ?? []).not.toContain('claude')

    releaseWrite()
    await Promise.all([pendingWrite, flagged])
    expect(store.read().officialProviders).toContain('claude')
  })

  it('keeps the original error when the undo works and says what is left when it does not', () => {
    const { service } = createService()
    const failure = new Error('配置没写进去')

    expect(service.withCredentialUndo(failure, () => undefined, '官方 Key 还在一边')).toBe(failure)
    const reported = service.withCredentialUndo(failure, () => { throw new Error('放不回去') }, '官方 Key 还在一边')
    expect(reported).toBeInstanceOf(Error)
    expect((reported as Error).message).toBe('配置没写进去（官方 Key 还在一边）')
  })

  // 0.2.24 深查「反复切换」N5：切回官方以后配置里就没有当前账号那份型号了，切之前记下来，再改用当前账号时还给它。
  it('remembers the model chosen on the account when a tool switches back to the official account', async () => {
    const { store, roots, service } = createService()
    saveProviderConfig('grok', 'sk-relay', 'grok-code-fast', 'merge', roots, {}, providerBaseUrls)

    await service.switchToOfficialAccount('grok')

    expect(store.read().officialProviders).toContain('grok')
    expect(store.read().relayModelsBeforeOfficial).toEqual({ grok: 'grok-code-fast' })
    expect(service.relayModelBeforeOfficial('grok')).toBe('grok-code-fast')
    // Resetting a config that is already official must not record the official side as the account's model.
    await service.switchToOfficialAccount('grok', 'reset')
    expect(service.relayModelBeforeOfficial('grok')).toBe('grok-code-fast')
    expect(service.relayModelBeforeOfficial('claude')).toBeNull()
  })

  it('falls back to the stored Codex account config for a switch made before the model was remembered', async () => {
    const { store, roots, service } = createService()
    saveProviderConfig('codex', 'sk-relay', 'gpt-5.4-mini', 'merge', roots, {}, providerBaseUrls)
    await service.switchToOfficialAccount('codex')
    expect(service.relayModelBeforeOfficial('codex')).toBe('gpt-5.4-mini')

    const { relayModelsBeforeOfficial: _remembered, ...withoutMemo } = store.read()
    await store.write(withoutMemo)
    expect(store.read()).not.toHaveProperty('relayModelsBeforeOfficial')
    expect(service.relayModelBeforeOfficial('codex')).toBe('gpt-5.4-mini')
  })

  it('still finishes the official switch when the model cannot be remembered', async () => {
    const logged: string[] = []
    const { store, roots, service } = createService({ runtimeLog: { log: (_level, _source, event) => { logged.push(event) } } })
    saveProviderConfig('grok', 'sk-relay', 'grok-code-fast', 'merge', roots, {}, providerBaseUrls)
    vi.spyOn(store, 'update').mockRejectedValue(new Error('磁盘满了'))

    await expect(service.switchToOfficialAccount('grok')).resolves.toBeDefined()

    expect(store.read().officialProviders).toContain('grok')
    expect(logged).toContain('official-switch.relay-model-unsaved')
  })

  it('takes the model only from a config on the account site, on any of its lines', () => {
    const site = relaySites.find((entry) => entry.id === 'solov')!
    const lines = relaySiteEndpointChoices('solov')
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) {
      expect(relayModelBeforeOfficialSwitch('codex', { actualBaseUrl: `${line.origin}/v1`, model: ' gpt-5.4-mini ' }, site)).toBe('gpt-5.4-mini')
    }
    expect(relayModelBeforeOfficialSwitch('codex', { actualBaseUrl: 'https://other.example/v1', model: 'glm-5' }, site)).toBeNull()
    expect(relayModelBeforeOfficialSwitch('codex', { actualBaseUrl: '', model: 'gpt-5.5' }, site)).toBeNull()
    expect(relayModelBeforeOfficialSwitch('codex', { actualBaseUrl: site.providerBaseUrls.codex, model: '' }, site)).toBeNull()
  })

  // Fable 复查第一轮 3：老配置切回官方以后「不逐条确认」还开着，问客户一次；点了「改回先问我」才改。
  describe('the one question about the official Claude Code asking first', () => {
    function legacyOfficialClaude(userHome: string): string {
      // What a pre-0.2.24 relay config looks like after the official switch: no marks, so the bypass mode stayed.
      const configPath = path.join(userHome, '.claude', 'settings.json')
      fs.writeFileSync(configPath, JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' }, skipDangerousModePermissionPrompt: true, theme: 'dark' }))
      return configPath
    }

    it('asks while the bypass mode is left and stops asking once answered either way', async () => {
      for (const choice of ['ask', 'keep'] as const) {
        const { store, userHome, service } = createService()
        legacyOfficialClaude(userHome)
        expect(service.claudeCommandConfirmationQuestionPending()).toBe(true)

        await service.answerClaudeCommandConfirmation(choice)

        expect(store.read().claudeCommandConfirmationAnswered).toBe(true)
        expect(service.claudeCommandConfirmationQuestionPending()).toBe(false)
      }
    })

    it('changes the settings only for「改回先问我」and backs up right before it writes', async () => {
      const { userHome, service } = createService()
      const configPath = legacyOfficialClaude(userHome)
      const before = fs.readFileSync(configPath, 'utf8')
      const backup = vi.fn()

      await expect(service.answerClaudeCommandConfirmation('keep', backup)).resolves.toEqual({ choice: 'keep', changed: false })
      expect(backup).not.toHaveBeenCalled()
      expect(fs.readFileSync(configPath, 'utf8')).toBe(before)

      await expect(service.answerClaudeCommandConfirmation('ask', backup)).resolves.toEqual({ choice: 'ask', changed: true })
      expect(backup).toHaveBeenCalledTimes(1)
      expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual({ theme: 'dark' })
      // Nothing left to change: no second backup, still reported as answered.
      await expect(service.answerClaudeCommandConfirmation('ask', backup)).resolves.toEqual({ choice: 'ask', changed: false })
      expect(backup).toHaveBeenCalledTimes(1)
    })

    it('does not ask when the bypass mode is gone or the config is on the account', () => {
      const { userHome, roots, service } = createService()
      expect(service.claudeCommandConfirmationQuestionPending()).toBe(false)
      saveProviderConfig('claude', 'sk-relay', 'claude-sonnet-5', 'merge', roots, {}, providerBaseUrls)
      expect(JSON.parse(fs.readFileSync(path.join(userHome, '.claude', 'settings.json'), 'utf8')).permissions.defaultMode).toBe('bypassPermissions')
      expect(service.claudeCommandConfirmationQuestionPending()).toBe(false)
    })

    it('keeps asking next time when the change is refused, and finishes an answer it cannot record', async () => {
      const logged: string[] = []
      const { store, userHome, roots, service } = createService({ runtimeLog: { log: (_level, _source, event) => { logged.push(event) } } })
      saveProviderConfig('claude', 'sk-relay', 'claude-sonnet-5', 'merge', roots, {}, providerBaseUrls)
      await expect(service.answerClaudeCommandConfirmation('ask')).rejects.toThrow('Claude Code 现在没在用官方账号，这次没有改。')
      expect(store.read()).not.toHaveProperty('claudeCommandConfirmationAnswered')

      legacyOfficialClaude(userHome)
      vi.spyOn(store, 'update').mockRejectedValue(new Error('磁盘满了'))
      await expect(service.answerClaudeCommandConfirmation('ask')).resolves.toEqual({ choice: 'ask', changed: true })
      expect(logged).toContain('claude.command-confirmation-unsaved')
    })

    it('waits for a config write already in the shared queue', async () => {
      const { context, userHome, service } = createService()
      const configPath = legacyOfficialClaude(userHome)
      let releaseWrite!: () => void
      const pendingWrite = context.serializeConfigWrite(() => new Promise<void>((resolve) => { releaseWrite = resolve }))

      const answered = service.answerClaudeCommandConfirmation('ask')
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).permissions).toEqual({ defaultMode: 'bypassPermissions' })

      releaseWrite()
      await Promise.all([pendingWrite, answered])
      expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual({ theme: 'dark' })
    })
  })
})

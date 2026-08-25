import { describe, expect, it } from 'vitest'
import { providerIds } from './types'
import {
  accountSourceSwitchAction,
  canLaunchManagedProvider,
  codexRelayStillUsesChatGptAuth,
  canRefreshOfficialChatGptUsage,
  codexDesktopLaunchDialogCopy,
  managedProviderLaunchBlockedMessage,
  officialAccountLabel,
  officialAccountLoginHint,
  officialChatGptUsageRefreshMs,
  providerAccountSource,
  providerAccountSourceLabel,
  providerConfigReadiness,
  providerConfigReadinessLabel,
} from './account-source'

describe('providerAccountSource', () => {
  it('reports the relay when the configured key points at the xingmang base URL', () => {
    expect(providerAccountSource({ hasApiKey: true, matchesRelay: true })).toBe('relay')
  })

  it('reports the official subscription when no relay key is configured', () => {
    expect(providerAccountSource({ hasApiKey: false, matchesRelay: false })).toBe('official')
  })

  it('treats a missing summary as official rather than throwing -- config may not be loaded yet', () => {
    expect(providerAccountSource(null)).toBe('official')
    expect(providerAccountSource(undefined)).toBe('official')
  })

  it('reports unknown for a key pointing somewhere that is not the relay', () => {
    // The switch action refuses this case in the main process; the UI must be
    // able to say why rather than offering a button that always fails.
    expect(providerAccountSource({ hasApiKey: true, matchesRelay: false })).toBe('unknown')
  })
})

describe('officialAccountLabel', () => {
  it('names the subscription for every CLI that has one, and only excludes Grok', () => {
    expect(officialAccountLabel('codex')).toBe('ChatGPT 账号')
    expect(officialAccountLabel('claude')).toBe('Claude 账号')
    expect(officialAccountLabel('gemini')).toBe('Google 账号')
    // xAI CLI authenticates with an API key only -- there is nothing to switch to.
    expect(officialAccountLabel('grok')).toBeNull()
  })

  it('covers every provider id, so adding a fifth CLI cannot silently skip this switch', () => {
    for (const provider of providerIds) {
      expect(() => officialAccountLabel(provider)).not.toThrow()
      expect(typeof officialAccountLoginHint(provider)).toBe('string')
    }
  })
})

describe('accountSourceSwitchAction', () => {
  it('lets relay and official toggle, and refuses a third-party URL', () => {
    expect(accountSourceSwitchAction('relay', 'official')).toBe('switch-official')
    expect(accountSourceSwitchAction('official', 'relay')).toBe('switch-relay')
    expect(accountSourceSwitchAction('official', 'official')).toBe('noop')
    expect(accountSourceSwitchAction('relay', 'relay')).toBe('noop')
    expect(accountSourceSwitchAction('unknown', 'official')).toBe('blocked')
    expect(accountSourceSwitchAction('unknown', 'relay')).toBe('blocked')
  })

  it('reapplies the Xingmang relay when Codex is still on ChatGPT auth_mode', () => {
    expect(accountSourceSwitchAction('relay', 'relay', { codexAuthMode: 'chatgpt' })).toBe('switch-relay')
    expect(accountSourceSwitchAction('relay', 'relay', { codexAuthMode: 'apikey' })).toBe('noop')
    expect(codexRelayStillUsesChatGptAuth({
      hasApiKey: true,
      matchesRelay: true,
      codexAuthMode: 'chatgpt',
    })).toBe(true)
    expect(codexRelayStillUsesChatGptAuth({
      hasApiKey: true,
      matchesRelay: true,
      codexAuthMode: 'apikey',
    })).toBe(false)
  })
})

describe('providerAccountSourceLabel', () => {
  it('renders each source in the user-facing wording', () => {
    expect(providerAccountSourceLabel('relay', 'codex')).toBe('星芒中转')
    expect(providerAccountSourceLabel('official', 'codex')).toBe('ChatGPT 账号')
    expect(providerAccountSourceLabel('unknown', 'codex')).toBe('自定义（第三方地址）')
    // Grok has no official label to fall back on.
    expect(providerAccountSourceLabel('official', 'grok')).toBe('未配置')
  })
})

describe('providerConfigReadiness', () => {
  it('does not call an official ChatGPT login “needs reconfiguration”', () => {
    const official = { exists: true, hasApiKey: false, matchesRelay: false }
    expect(providerConfigReadiness(official)).toBe('official')
    expect(providerConfigReadinessLabel(official, 'codex')).toBe('ChatGPT 账号已登录')
    expect(providerConfigReadinessLabel(official, 'codex', 'dashboard')).toBe('ChatGPT 账号已登录')
    expect(providerConfigReadinessLabel(official, 'codex', 'desktop')).toBe('共用 ChatGPT 账号已登录')
  })

  it('keeps the Xingmang and third-party labels', () => {
    expect(providerConfigReadinessLabel({ exists: true, hasApiKey: true, matchesRelay: true }, 'codex')).toBe('星芒 AI 已配置')
    expect(providerConfigReadinessLabel({ exists: true, hasApiKey: true, matchesRelay: false }, 'codex')).toBe('需要重新配置')
    expect(providerConfigReadinessLabel({ exists: false, hasApiKey: false, matchesRelay: false }, 'codex', 'dashboard')).toBe('配置文件未创建')
  })
})

describe('canLaunchManagedProvider', () => {
  it('lets Xingmang relay and official ChatGPT launch Codex, and refuses a third-party URL', () => {
    expect(canLaunchManagedProvider({ hasApiKey: true, matchesRelay: true }, 'codex')).toBe(true)
    expect(canLaunchManagedProvider({ hasApiKey: false, matchesRelay: false }, 'codex')).toBe(true)
    expect(canLaunchManagedProvider({ hasApiKey: true, matchesRelay: false }, 'codex')).toBe(false)
    expect(canLaunchManagedProvider(null, 'codex')).toBe(true)
  })

  it('refuses Grok without a Xingmang key because xAI CLI has no official login', () => {
    expect(canLaunchManagedProvider({ hasApiKey: false, matchesRelay: false }, 'grok')).toBe(false)
    expect(canLaunchManagedProvider({ hasApiKey: true, matchesRelay: true }, 'grok')).toBe(true)
    expect(managedProviderLaunchBlockedMessage('codex')).toContain('ChatGPT 账号')
    expect(managedProviderLaunchBlockedMessage('grok')).toContain('星芒 AI')
  })
})

describe('codexDesktopLaunchDialogCopy', () => {
  it('does not imply restart is Xingmang-only when the source is ChatGPT', () => {
    const official = codexDesktopLaunchDialogCopy('official')
    expect(official.title).toBe('Codex 已在运行')
    expect(official.subtitle).toContain('ChatGPT')
    expect(official.restartHint).toContain('ChatGPT')
    expect(codexDesktopLaunchDialogCopy('relay').subtitle).toContain('星芒中转')
  })
})

describe('canRefreshOfficialChatGptUsage', () => {
  it('is only available for a ChatGPT official Codex account', () => {
    expect(canRefreshOfficialChatGptUsage({ exists: true, hasApiKey: false, matchesRelay: false })).toBe(true)
    expect(canRefreshOfficialChatGptUsage({ exists: true, hasApiKey: true, matchesRelay: true })).toBe(false)
    expect(canRefreshOfficialChatGptUsage({ exists: true, hasApiKey: true, matchesRelay: false })).toBe(false)
    expect(canRefreshOfficialChatGptUsage({ exists: false, hasApiKey: false, matchesRelay: false })).toBe(false)
    expect(canRefreshOfficialChatGptUsage(null)).toBe(false)
    expect(officialChatGptUsageRefreshMs).toBe(60 * 60 * 1000)
  })
})

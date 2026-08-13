import { describe, expect, it } from 'vitest'
import { providerIds } from './types'
import {
  officialAccountLabel,
  officialAccountLoginHint,
  providerAccountSource,
  providerAccountSourceLabel,
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

describe('providerAccountSourceLabel', () => {
  it('renders each source in the user-facing wording', () => {
    expect(providerAccountSourceLabel('relay', 'codex')).toBe('星芒中转')
    expect(providerAccountSourceLabel('official', 'codex')).toBe('ChatGPT 账号')
    expect(providerAccountSourceLabel('unknown', 'codex')).toBe('自定义（第三方地址）')
    // Grok has no official label to fall back on.
    expect(providerAccountSourceLabel('official', 'grok')).toBe('未配置')
  })
})

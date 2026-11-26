import { describe, expect, it } from 'vitest'
import type { StoredManagedCliKey } from './managed-cli-key-store'
import { antigravityAccountKeys, antigravityLogSource } from './system-service'

describe('system-service Antigravity wiring', () => {
  it('takes the Gemini keys of the current account cache, which is what Antigravity uses', () => {
    const cached: StoredManagedCliKey[] = [
      { id: 1, provider: 'claude', group: 'Claude', name: 'claude-cli', key: 'sk-claude-0123456789' },
      { id: 2, provider: 'gemini', group: 'Gemini', name: 'gemini-cli', key: 'sk-gemini-0123456789' },
      { id: 3, provider: 'codex', group: 'Codex', name: 'codex-cli', key: 'sk-codex-0123456789' },
    ]
    expect(antigravityAccountKeys(cached)).toEqual(['sk-gemini-0123456789'])
    expect(antigravityAccountKeys([])).toEqual([])
  })

  it('files the follow-up after an account or line change under settings', () => {
    expect(antigravityLogSource('antigravity.settings.followed')).toBe('config')
    expect(antigravityLogSource('antigravity.settings.follow-failed')).toBe('config')
  })
})

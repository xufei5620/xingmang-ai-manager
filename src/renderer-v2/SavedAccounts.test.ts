import { describe, expect, it } from 'vitest'
import { defaultSyncSelection, savedAccountLoginTarget, savedAccountSourceLabel } from './SavedAccounts'

describe('saved account list labels', () => {
  it('names the account source with the login page tab names instead of a hash fragment', () => {
    expect(savedAccountSourceLabel('https://xm.solov.cc')).toBe('星芒账号')
    expect(savedAccountSourceLabel('https://api.solov.cc')).toBe('历史账号')
  })
  it('never echoes an unrecognised origin back to the user', () => {
    for (const origin of ['https://api.solov.cc.evil.com', 'http://xm.solov.cc', ''])
      expect(savedAccountSourceLabel(origin)).toBe('账号来源无法识别')
  })
  it('points relogin at the saved account source and name, and leaves unknown sources to the default login', () => {
    expect(savedAccountLoginTarget({ origin: 'https://api.solov.cc', username: 'old@example.com' })).toEqual({ siteId: 'solov-api', identifier: 'old@example.com' })
    expect(savedAccountLoginTarget({ origin: 'https://xm.solov.cc', username: 'saved-user' })).toEqual({ siteId: 'solov', identifier: 'saved-user' })
    expect(savedAccountLoginTarget({ origin: 'https://api.solov.cc.evil.com', username: 'x' })).toBeUndefined()
  })
  it('leaves a legacy account relogin blank when the saved name is a nickname, so the remembered email can fill it', () => {
    expect(savedAccountLoginTarget({ origin: 'https://api.solov.cc', username: 'fixture-user' })).toEqual({ siteId: 'solov-api', identifier: '' })
    expect(savedAccountLoginTarget({ origin: 'https://xm.solov.cc', username: 'fixture-user' })).toEqual({ siteId: 'solov', identifier: 'fixture-user' })
  })
})

describe('saved account switch sync defaults', () => {
  const candidate = (provider: 'claude' | 'codex' | 'gemini' | 'grok', reason: string, eligible = reason === '星芒密钥' || reason === '手动填写密钥') =>
    ({ provider, name: provider, eligible, reason, model: '' })
  const candidates = [
    candidate('claude', '星芒密钥'),
    candidate('codex', '手动填写密钥'),
    candidate('gemini', '官方账号'),
    candidate('grok', '星芒密钥'),
  ]
  it('switches tools already on the account key along with the account unless the user unticks them', () => {
    expect(defaultSyncSelection(candidates, {})).toEqual(['claude', 'grok'])
    expect(defaultSyncSelection(candidates, { grok: false })).toEqual(['claude'])
  })
  it('leaves a hand-entered key alone by default but honours an explicit tick', () => {
    expect(defaultSyncSelection(candidates, { codex: true })).toEqual(['claude', 'codex', 'grok'])
  })
  it('never selects a tool that cannot be switched, whatever the stored choice says', () => {
    expect(defaultSyncSelection(candidates, { gemini: true })).toEqual(['claude', 'grok'])
  })
})

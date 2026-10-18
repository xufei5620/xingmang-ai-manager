import { describe, expect, it } from 'vitest'
import { accountSwitchDesktopClientsHint, accountSwitchedTitle, defaultSyncSelection, savedAccountLoginTarget, savedAccountSourceLabel } from './SavedAccounts'

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
  it('says which account and which kind the switch landed on, and falls back when either is unknown', () => {
    expect(accountSwitchedTitle('peaker', 'https://xm.solov.cc')).toBe('已切换到「peaker」（星芒账号）')
    expect(accountSwitchedTitle('old@example.com', 'https://api.solov.cc')).toBe('已切换到「old@example.com」（历史账号）')
    expect(accountSwitchedTitle(undefined, 'https://xm.solov.cc')).toBe('账号已切换')
    expect(accountSwitchedTitle('peaker', 'https://xm.solov.cc.evil.com')).toBe('账号已切换')
  })
})

describe('saved account switch sync defaults', () => {
  const candidate = (provider: 'claude' | 'codex' | 'grok', reason: string, eligible = reason === '当前账号' || reason === '自己的密钥') =>
    ({ provider, name: provider, eligible, reason, model: '' })
  const candidates = [
    candidate('claude', '当前账号'),
    candidate('codex', '自己的密钥'),
    candidate('grok', '当前账号'),
  ]
  it('switches tools already on the account key along with the account unless the user unticks them', () => {
    expect(defaultSyncSelection(candidates, {})).toEqual(['claude', 'grok'])
    expect(defaultSyncSelection(candidates, { grok: false })).toEqual(['claude'])
  })
  it('leaves a hand-entered key alone by default but honours an explicit tick', () => {
    expect(defaultSyncSelection(candidates, { codex: true })).toEqual(['claude', 'codex', 'grok'])
  })
  it('never selects a tool that cannot be switched, whatever the stored choice says', () => {
    const withOfficial = [candidate('claude', '当前账号'), candidate('codex', '官方账号'), candidate('grok', '尚未安装')]
    expect(defaultSyncSelection(withOfficial, { codex: true, grok: true })).toEqual(['claude'])
  })
})

describe('saved account switch desktop clients', () => {
  it('tells Windows and Mac users the desktop clients keep the old key and where to change it', () => {
    for (const os of ['win', 'mac'] as const) {
      const hint = accountSwitchDesktopClientsHint(os)
      expect(hint).toContain('Claude Desktop、WorkBuddy、OpenCode 不会跟着换')
      expect(hint).toContain('「配置…」')
      expect(hint).toContain('「保存并检测」')
    }
  })
  it('says nothing on Linux, where the home page does not list those clients', () => {
    expect(accountSwitchDesktopClientsHint('linux')).toBeNull()
  })
})

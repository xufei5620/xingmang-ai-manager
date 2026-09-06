import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { SavedAccount } from '../../types'
import { AccountSwitcher, savedAccountMatchesOrigin, selectedSyncProviders } from './AccountSwitcher'

const account: SavedAccount = { id: 'account-a', userId: 1, username: 'A', origin: 'https://xm.example.com', updatedAt: '2026-09-07T00:00:00.000Z' }
describe('AccountSwitcher', () => {
  it('compares canonical site origins without mixing equal user IDs across sites', () => {
    expect(savedAccountMatchesOrigin(account, 'https://XM.EXAMPLE.COM:443/account')).toBe(true)
    expect(savedAccountMatchesOrigin(account, 'https://other.example.com')).toBe(false)
    expect(savedAccountMatchesOrigin(account, 'https://user:pass@xm.example.com')).toBe(false)
    expect(savedAccountMatchesOrigin(account, 'invalid')).toBe(false)
  })

  it('never selects a sync provider automatically and filters sources that are no longer allowed', () => {
    const tools = [{ id: 'codex' as const, label: 'Codex', source: '星芒', allowed: true }, { id: 'claude' as const, label: 'Claude', source: '官方', allowed: false }]
    expect(selectedSyncProviders(new Set(), tools)).toEqual([])
    expect(selectedSyncProviders(new Set(['codex', 'claude']), tools)).toEqual(['codex'])
  })

  it('starts in an explicit loading state rather than showing a fake empty account list', () => {
    const markup = renderToStaticMarkup(<AccountSwitcher activeUserId={1} accountsOrigin={account.origin} loadAccounts={vi.fn()} onSwitch={vi.fn()} onRemove={vi.fn()} onAddAccount={vi.fn()} onClose={vi.fn()} syncTools={[]} />)
    expect(markup).toContain('正在读取已保存账号')
    expect(markup).not.toContain('还没有已保存账号')
    expect(markup).toContain('role="dialog"')
    expect(markup).toContain('aria-modal="true"')
  })
})

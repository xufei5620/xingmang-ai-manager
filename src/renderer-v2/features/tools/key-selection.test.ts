import { describe, expect, it, vi } from 'vitest'
import type { AccountKey, AppConfigSummary, AccountKeysPage } from '../../../../electron/ipc-contract'
import { accountKeyLabel, currentKeyLabel, initialKeyChoice, manualKeyPreview, readAllAccountKeys } from './key-selection'

const key = (id: number) => ({ id, name: `key-${id}`, group: 'Group A', maskedKey: 'sk-••••1234', status: 1 }) as AccountKey

describe('configuration key selection', () => {
  it('preserves an existing local key and never infers its group from a matching suffix', () => {
    expect(initialKeyChoice({ hasApiKey: true, matchesRelay: true } as AppConfigSummary['providers']['codex'])).toBe('current')
    expect(initialKeyChoice({ hasApiKey: false, matchesRelay: false } as AppConfigSummary['providers']['codex'])).toBe('automatic')
    expect(currentKeyLabel(null, 'sk-••••1234')).toBe('保持当前 · 名称未确认 · sk-••••1234')
    expect(accountKeyLabel(key(1))).toBe('key-1 · Group A · sk-••••1234')
    expect(accountKeyLabel({ ...key(2), group: '' })).toBe('key-2 · sk-••••1234')
  })
  it('defaults to an automatic key when the local key belongs to another site', () => {
    // 「保持当前」对别的站的 Key 存不进去（主进程报「属于其他账号」），不能默认选它。
    expect(initialKeyChoice({ hasApiKey: true, matchesRelay: false } as AppConfigSummary['providers']['codex'])).toBe('automatic')
  })
  it('reads every page so a key beyond the first 100 is selectable', async () => {
    const read = vi.fn(async ({ page = 1 }: { page?: number }) => ({ page, pageSize: 100, total: 101,
      keys: page === 1 ? Array.from({ length: 100 }, (_, index) => key(index + 1)) : [key(101)] }))
    const result = await readAllAccountKeys(read)
    expect(result.keys.map((item) => item.id)).toEqual(Array.from({ length: 101 }, (_, index) => index + 1))
    expect(read.mock.calls).toEqual([[{ page: 1, pageSize: 100 }], [{ page: 2, pageSize: 100 }]])
  })
  it('fails visibly on a changing or incomplete key list instead of presenting a partial list', async () => {
    const read = vi.fn(async ({ page = 1 }: { page?: number }): Promise<AccountKeysPage> => ({ page, pageSize: 100, total: 2, keys: [key(1)] }))
    await expect(readAllAccountKeys(read)).rejects.toThrow('发生变化')
    await expect(readAllAccountKeys(async () => ({ page: 1, pageSize: 100, total: 1, keys: [] }))).rejects.toThrow('未完整返回')
  })
  it('shows only genuine prefixes and does not expose a whole short manual credential', () => {
    expect(manualKeyPreview('sk-test-secret')).toBe('sk-••••••••cret')
    expect(manualKeyPreview('test-secret')).toBe('••••••••cret')
    expect(manualKeyPreview('abcd')).toBe('••••••••')
    expect(manualKeyPreview('sk-ab')).toBe('sk-••••••••')
  })
})

import { describe, expect, it, vi } from 'vitest'
import type { AccountKey, AppConfigSummary, AccountKeysPage } from '../../../../electron/ipc-contract'
import { accountKeyDescription, currentKeyLabel, initialKeyChoice, listedAccountKeys, manualKeyIssue, manualKeyPreview, readAllAccountKeys } from './key-selection'

const key = (id: number) => ({ id, name: `key-${id}`, group: 'Group A', maskedKey: 'sk-••••1234', status: 1 }) as AccountKey

describe('configuration key selection', () => {
  it('preserves an existing local key and never infers its group from a matching suffix', () => {
    expect(initialKeyChoice({ hasApiKey: true, matchesRelay: true } as AppConfigSummary['providers']['codex'])).toBe('current')
    expect(initialKeyChoice({ hasApiKey: false, matchesRelay: false } as AppConfigSummary['providers']['codex'])).toBe('automatic')
    expect(currentKeyLabel(null, 'sk-••••1234')).toBe('保持当前 · 名称未确认 · sk-••••1234')
  })
  it('puts the mask before the group on the second line of a key option', () => {
    expect(accountKeyDescription(key(1))).toBe('sk-••••1234，Group A分组')
    expect(accountKeyDescription({ ...key(1), group: '' })).toBe('sk-••••1234')
    expect(accountKeyDescription({ ...key(1), maskedKey: '' })).toBe('密钥预览未提供，Group A分组')
  })
  it('lists one key per name and group among the keys Xingmang signed', () => {
    const named = (id: number, name: string, group: string, accessedAt: string | null, status = 1) => ({ ...key(id), name, group, accessedAt, status }) as AccountKey
    const keys = [
      named(1, 'xingmang-chat-abc', 'Claude-KIRO(高缓)', null),
      named(2, 'xingmang-desktop-codex', 'GPT', '2026-10-15T08:00:00.000Z'),
      named(3, 'xingmang-desktop-gemini', 'Gemini', null),
      named(4, 'xingmang-ai', '图片模型', null),
      named(5, 'xingmang-desktop-codex', 'GPT', '2026-10-16T08:00:00.000Z'),
      named(6, 'xingmang-ai', '图片模型', null),
      named(7, 'xingmang-desktop-claude', 'Claude-MAX', null),
      named(8, 'xingmang-desktop-claude', 'Claude-MAX', '2026-10-16T09:00:00.000Z', 2),
      named(9, 'my-own-key', 'GPT', null),
      named(10, 'my-own-key', 'GPT', null),
      named(11, 'xingmang-desktop-codex', 'Codex 专线', null),
    ]
    // 同组同名留最近用过的那把；都没用过留后建的；停用的不算；自己建的同名密钥、别的分组里的不合并；下线工具那把不列。
    expect(listedAccountKeys(keys, 'current').map((entry) => entry.id)).toEqual([1, 5, 6, 7, 9, 10, 11])
    // 正选着的那把留下，同组同名的另一把不再列。
    expect(listedAccountKeys(keys, '2').map((entry) => entry.id)).toEqual([1, 2, 6, 7, 9, 10, 11])
    expect(listedAccountKeys(keys, '3').map((entry) => entry.id)).toEqual([1, 3, 5, 6, 7, 9, 10, 11])
  })
  it('checks the sk- prefix only where the key format is known', () => {
    expect(manualKeyIssue('  ', true)).toBe('请粘贴你在星芒创建的密钥')
    expect(manualKeyIssue('', false)).toBe('请粘贴你在星芒创建的密钥')
    expect(manualKeyIssue('abc-12345678901234567890', true)).toContain('应以 sk- 开头')
    expect(manualKeyIssue('sk-short', true)).toContain('20 位以上')
    expect(manualKeyIssue(' sk-12345678901234567 ', true)).toBeNull()
    // 历史账号的密钥前缀没核实，只拦空的。
    expect(manualKeyIssue('abc', false)).toBeNull()
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

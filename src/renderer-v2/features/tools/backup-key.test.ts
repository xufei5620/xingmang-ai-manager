import { describe, expect, it } from 'vitest'
import { backupKeyView } from './backup-key'

describe('backupKeyView', () => {
  it('labels the signed-in account key without a restore warning', () => {
    expect(backupKeyView({ keyOwnership: 'current', keyAccountName: null })).toEqual({
      tone: 'ok', label: '当前账号的 Key', restoreWarning: null,
    })
  })

  it('names the account that issued another key and warns before restoring it', () => {
    const view = backupKeyView({ keyOwnership: 'other', keyAccountName: 'old-user' })
    expect(view?.label).toBe('账号 old-user 的 Key')
    expect(view?.restoreWarning).toMatch(/^这份备份里是账号 old-user 的 Key。/)
  })

  it('warns about an unnamed foreign key without inventing an owner', () => {
    const view = backupKeyView({ keyOwnership: 'other', keyAccountName: null })
    expect(view?.label).toBe('不是当前账号的 Key')
    expect(view?.restoreWarning).toMatch(/^这份备份里的 Key 不是当前账号的。/)
  })

  it('reports a backup without a key', () => {
    expect(backupKeyView({ keyOwnership: 'none', keyAccountName: null })?.label).toBe('没有 Key')
  })

  it('leaves legacy backups unlabelled', () => {
    expect(backupKeyView({ keyOwnership: 'unknown', keyAccountName: null })).toBeNull()
    expect(backupKeyView({})).toBeNull()
  })

  it('never mentions a site name', () => {
    for (const keyOwnership of ['current', 'other', 'none'] as const) {
      expect(JSON.stringify(backupKeyView({ keyOwnership, keyAccountName: 'x' }))).not.toMatch(/星芒站|solov|Sub2API/i)
    }
  })
})

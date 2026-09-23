import { describe, expect, it } from 'vitest'
import { savedAccountSourceLabel } from './SavedAccounts'

describe('saved account list labels', () => {
  it('names the account source with the login page tab names instead of a hash fragment', () => {
    expect(savedAccountSourceLabel('https://xm.solov.cc')).toBe('星芒账号')
    expect(savedAccountSourceLabel('https://api.solov.cc')).toBe('历史账号')
  })
  it('never echoes an unrecognised origin back to the user', () => {
    for (const origin of ['https://api.solov.cc.evil.com', 'http://xm.solov.cc', ''])
      expect(savedAccountSourceLabel(origin)).toBe('账号来源无法识别')
  })
})

import { describe, expect, it } from 'vitest'
import { localPathForDisplay } from './local-path-display'

describe('localPathForDisplay', () => {
  it('masks Windows user profile and AppData roots', () => {
    expect(localPathForDisplay('C:\\Users\\peaker\\.codex\\config.toml'))
      .toBe('%USERPROFILE%\\.codex\\config.toml')
    expect(localPathForDisplay('C:\\Users\\peaker\\AppData\\Roaming\\npm'))
      .toBe('%APPDATA%\\npm')
    expect(localPathForDisplay('C:/Users/peaker/AppData/Local/Programs/nodejs'))
      .toBe('%LOCALAPPDATA%\\Programs\\nodejs')
  })

  it('masks POSIX home directories and preserves machine paths', () => {
    expect(localPathForDisplay('/Users/peaker/.codex/config.toml')).toBe('~/.codex/config.toml')
    expect(localPathForDisplay('/home/peaker/.claude/settings.json')).toBe('~/.claude/settings.json')
    expect(localPathForDisplay('C:\\Program Files\\nodejs')).toBe('C:\\Program Files\\nodejs')
  })
})

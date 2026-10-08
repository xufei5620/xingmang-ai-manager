import { describe, expect, it } from 'vitest'
import { diagnosticFixConfirm, diagnosticFixKind, diagnosticFixLabel, diagnosticFixMessage } from './diagnostic-fix'

describe('diagnostic one-click fixes', () => {
  it('offers a fix only where the main process marked the row as fixable', () => {
    expect(diagnosticFixKind({ code: 'CODEX_DOTENV', state: 'warn', details: { fix: 'set-aside-codex-dotenv' } })).toBe('set-aside-codex-dotenv')
    expect(diagnosticFixKind({ code: 'PROVIDER_ENVIRONMENT_OVERRIDE', state: 'fail', details: { fix: 'clear-user-overrides' } })).toBe('clear-user-overrides')
    expect(diagnosticFixLabel({ code: 'PROVIDER_ENVIRONMENT_OVERRIDE', state: 'fail', details: { fix: 'clear-user-overrides' } })).toBe('删掉这几项设置')
    expect(diagnosticFixKind({ code: 'CODEX_DOTENV', state: 'warn', details: { exists: true } })).toBeNull()
    expect(diagnosticFixKind({ code: 'CODEX_DOTENV', state: 'pass', details: { fix: 'set-aside-codex-dotenv' } })).toBeNull()
    // 标记和行对不上的不认：别的行不许借这个按钮。
    expect(diagnosticFixKind({ code: 'PROXY_ENVIRONMENT', state: 'warn', details: { fix: 'clear-user-overrides' } })).toBeNull()
    expect(diagnosticFixLabel({ code: 'DISK_SPACE', state: 'fail' })).toBeNull()
  })
  it('says what happened in plain words, including what still needs an administrator', () => {
    expect(diagnosticFixMessage({ kind: 'set-aside-codex-dotenv', fixed: 1, machineRemaining: false })).toContain('已经挪开')
    expect(diagnosticFixMessage({ kind: 'clear-user-overrides', fixed: 2, machineRemaining: true })).toContain('要管理员')
    expect(diagnosticFixMessage({ kind: 'clear-user-overrides', fixed: 0, machineRemaining: false })).toContain('没有要删的')
  })
  it('moves the home folder instructions only from their own row, with the agreed wording', () => {
    const row = { code: 'HOME_FOLDER_LEFTOVERS', state: 'warn', details: { fix: 'set-aside-home-agents-md' } }
    expect(diagnosticFixKind(row)).toBe('set-aside-home-agents-md')
    expect(diagnosticFixLabel(row)).toBe('挪开这份说明')
    // 只有信任、没有说明可挪时，主进程不放 fix，这一行没有按钮。
    expect(diagnosticFixKind({ code: 'HOME_FOLDER_LEFTOVERS', state: 'warn', details: { trustedBy: 'claude' } })).toBeNull()
    expect(diagnosticFixKind({ code: 'CODEX_DOTENV', state: 'warn', details: { fix: 'set-aside-home-agents-md' } })).toBeNull()
    expect(diagnosticFixConfirm['set-aside-home-agents-md']).toEqual({
      title: '挪开这份项目说明？',
      body: '这份文件会改个名字留在个人文件夹里，不会删掉。挪开之后，工具只看各个项目自己的说明。以后想用回来，把名字改回 AGENTS.md 就行。',
      ok: '挪开',
    })
    expect(diagnosticFixMessage({ kind: 'set-aside-home-agents-md', fixed: 1, machineRemaining: false })).toBe('已经挪开。')
    expect(diagnosticFixMessage({ kind: 'set-aside-home-agents-md', fixed: 0, machineRemaining: false })).toBe('没有要挪的了：这份说明已经不在了。')
  })
})

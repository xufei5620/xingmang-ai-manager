import { describe, expect, it } from 'vitest'
import { diagnosticFixKind, diagnosticFixLabel, diagnosticFixMessage } from './diagnostic-fix'

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
})

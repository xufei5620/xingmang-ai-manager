import { describe, expect, it } from 'vitest'
import { diagnosticFixConfirm, diagnosticFixKind, diagnosticFixLabel, diagnosticFixMessage } from './diagnostic-fix'

describe('diagnostic one-click fixes', () => {
  it('offers a fix only where the main process marked the row as fixable', () => {
    expect(diagnosticFixKind({ code: 'CODEX_DOTENV', state: 'warn', details: { fix: 'set-aside-codex-dotenv' } })).toBe('set-aside-codex-dotenv')
    expect(diagnosticFixKind({ code: 'PROVIDER_ENVIRONMENT_OVERRIDE', state: 'fail', details: { fix: 'clear-user-overrides' } })).toBe('clear-user-overrides')
    expect(diagnosticFixLabel({ code: 'PROVIDER_ENVIRONMENT_OVERRIDE', state: 'fail', details: { fix: 'clear-user-overrides' } })).toBe('删除这些设置')
    expect(diagnosticFixKind({ code: 'CODEX_DOTENV', state: 'warn', details: { exists: true } })).toBeNull()
    expect(diagnosticFixKind({ code: 'CODEX_DOTENV', state: 'pass', details: { fix: 'set-aside-codex-dotenv' } })).toBeNull()
    // 标记和行对不上的不认：别的行不许借这个按钮。
    expect(diagnosticFixKind({ code: 'PROXY_ENVIRONMENT', state: 'warn', details: { fix: 'clear-user-overrides' } })).toBeNull()
    expect(diagnosticFixLabel({ code: 'DISK_SPACE', state: 'fail' })).toBeNull()
  })
  it('says what happened in plain words, including what still needs an administrator', () => {
    expect(diagnosticFixMessage({ kind: 'set-aside-codex-dotenv', fixed: 1, machineRemaining: false })).toContain('已停用')
    expect(diagnosticFixMessage({ kind: 'clear-user-overrides', fixed: 2, machineRemaining: true })).toContain('需管理员权限')
    expect(diagnosticFixMessage({ kind: 'clear-user-overrides', fixed: 0, machineRemaining: false })).toContain('无需处理')
  })
  it('moves the home folder instructions only from their own row, with the agreed wording', () => {
    const row = { code: 'HOME_FOLDER_LEFTOVERS', state: 'warn', details: { fix: 'set-aside-home-agents-md' } }
    expect(diagnosticFixKind(row)).toBe('set-aside-home-agents-md')
    expect(diagnosticFixLabel(row)).toBe('停用此说明')
    // 只有信任、没有说明可挪时，主进程不放 fix，这一行没有按钮。
    expect(diagnosticFixKind({ code: 'HOME_FOLDER_LEFTOVERS', state: 'warn', details: { trustedBy: 'claude' } })).toBeNull()
    expect(diagnosticFixKind({ code: 'CODEX_DOTENV', state: 'warn', details: { fix: 'set-aside-home-agents-md' } })).toBeNull()
    expect(diagnosticFixConfirm['set-aside-home-agents-md']).toEqual({
      title: '是否停用此项目说明？',
      body: '该文件将重命名并保留在个人文件夹中，不会删除。停用后，工具仅读取各项目自身的说明。如需恢复，将文件名改回 AGENTS.md 即可。',
      ok: '停用',
    })
    expect(diagnosticFixMessage({ kind: 'set-aside-home-agents-md', fixed: 1, machineRemaining: false })).toBe('已停用。')
    expect(diagnosticFixMessage({ kind: 'set-aside-home-agents-md', fixed: 0, machineRemaining: false })).toBe('无需处理：该说明已不存在。')
  })
})

import { describe, expect, it } from 'vitest'
import { diagnosticGroup, diagnosticStateLabel, groupDiagnostics } from './diagnostic-group'

describe('diagnosticGroup', () => {
  it('puts passing items in the 正常 group whatever they are', () => {
    expect(diagnosticGroup({ code: 'XINGMANG_NETWORK', state: 'pass' })).toBe('ok')
    expect(diagnosticGroup({ code: 'CLI_GROK', state: 'pass', details: { installed: true } })).toBe('ok')
  })

  it('treats a missing optional runtime, CLI or the desktop app as optional', () => {
    for (const code of ['RUNTIME_PYTHON', 'RUNTIME_GIT', 'CLI_CLAUDE', 'CLI_GROK', 'CODEX_DESKTOP']) {
      expect(diagnosticGroup({ code, state: 'warn', details: { installed: false } }), code).toBe('optional')
    }
  })

  it('keeps a missing Node.js or npm, and any other warning, under 需要处理', () => {
    expect(diagnosticGroup({ code: 'RUNTIME_NODE', state: 'fail', details: { installed: false } })).toBe('problem')
    expect(diagnosticGroup({ code: 'RUNTIME_NPM', state: 'fail', details: { installed: false } })).toBe('problem')
    expect(diagnosticGroup({ code: 'PROXY_ENVIRONMENT', state: 'warn' })).toBe('problem')
    expect(diagnosticGroup({ code: 'CERTIFICATE_TRUST', state: 'warn', details: { verdict: 'elevated' } })).toBe('problem')
    // 诊断没说「没装」（读到了却打不开、检测出错）时不当成可选。
    expect(diagnosticGroup({ code: 'CLI_CODEX', state: 'fail' })).toBe('problem')
    expect(diagnosticGroup({ code: 'CLI_CODEX', state: 'warn' })).toBe('problem')
    expect(diagnosticGroup({ code: 'RUNTIME_PYTHON', state: 'error', details: { installed: false } })).toBe('problem')
  })
})

describe('groupDiagnostics', () => {
  it('splits the list into the three groups and keeps the order within each', () => {
    const items = [
      { code: 'CLI_CODEX', state: 'fail' },
      { code: 'RUNTIME_PYTHON', state: 'warn', details: { installed: false } },
      { code: 'PROXY_ENVIRONMENT', state: 'warn' },
      { code: 'CLI_GROK', state: 'warn', details: { installed: false } },
      { code: 'XINGMANG_NETWORK', state: 'pass' },
      { code: 'CERTIFICATE_TRUST', state: 'pass' },
    ]
    const groups = groupDiagnostics(items)
    expect(groups.problem.map((item) => item.code)).toEqual(['CLI_CODEX', 'PROXY_ENVIRONMENT'])
    expect(groups.optional.map((item) => item.code)).toEqual(['RUNTIME_PYTHON', 'CLI_GROK'])
    expect(groups.ok.map((item) => item.code)).toEqual(['XINGMANG_NETWORK', 'CERTIFICATE_TRUST'])
  })
})

describe('diagnosticStateLabel', () => {
  it('names the row icon with the three words the old badge used', () => {
    expect(diagnosticStateLabel('pass')).toBe('正常')
    expect(diagnosticStateLabel('warn')).toBe('需留意')
    expect(diagnosticStateLabel('fail')).toBe('待处理')
    expect(diagnosticStateLabel('error')).toBe('待处理')
  })
})

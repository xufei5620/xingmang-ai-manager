import { describe, expect, it } from 'vitest'
import type { NodeRuntimeInstallResult, PythonRuntimeInstallResult } from '../../../../electron/ipc-contract'
import { describeRuntimeInstallOutcome } from './runtime-install-outcome'

function nodeResult(overrides: Partial<NodeRuntimeInstallResult> = {}): NodeRuntimeInstallResult {
  return {
    installed: true,
    action: 'installed',
    method: 'msi',
    source: 'official',
    version: 'v22.20.0',
    architecture: 'x64',
    pathRefreshRequired: true,
    systemRestartRequired: false,
    ...overrides,
  }
}

function pythonResult(overrides: Partial<PythonRuntimeInstallResult> = {}): PythonRuntimeInstallResult {
  return {
    installed: true,
    action: 'installed',
    method: 'winget',
    source: 'winget',
    version: 'Python 3.12',
    architecture: 'x64',
    pathRefreshRequired: true,
    ...overrides,
  }
}

describe('describeRuntimeInstallOutcome', () => {
  it('asks for a Windows restart when the MSI returned 3010', () => {
    expect(describeRuntimeInstallOutcome('node', nodeResult({ systemRestartRequired: true }))).toEqual({
      message: 'Node.js 装好了，重启电脑后就能用。',
      tone: 'warn',
      restartRequired: true,
    })
  })

  it('does not ask the user to reopen anything when only PATH changed', () => {
    for (const outcome of [
      describeRuntimeInstallOutcome('node', nodeResult()),
      describeRuntimeInstallOutcome('python', pythonResult()),
    ]) {
      expect(outcome.restartRequired).toBe(false)
      expect(outcome.tone).toBe('ok')
      expect(outcome.message).not.toMatch(/重开|重启/)
    }
    expect(describeRuntimeInstallOutcome('python', pythonResult()).message).toBe('Python 装好了。')
  })

  it('says it was already there when nothing was installed', () => {
    const outcome = describeRuntimeInstallOutcome('node', nodeResult({
      action: 'unchanged', method: null, source: null, pathRefreshRequired: false,
    }))
    expect(outcome).toEqual({ message: 'Node.js 本来就装好了，不用重复安装。', tone: 'ok', restartRequired: false })
  })
})

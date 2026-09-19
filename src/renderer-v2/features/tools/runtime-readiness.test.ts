import { describe, expect, it } from 'vitest'
import type { SystemSnapshot } from '../../../../electron/ipc-contract'
import { cliRuntimeBlockMessage, nodeRuntimeReady } from './runtime-readiness'

const base = { installed: true, version: '1.0.0', path: null, installDirectory: null }

function runtime(node: Partial<SystemSnapshot['runtime']['node']>, npm: Partial<SystemSnapshot['runtime']['npm']> = {}): SystemSnapshot['runtime'] {
  return {
    node: { ...base, version: 'v22.0.0', tooOld: false, versionStatus: 'supported', ...node },
    npm: { ...base, version: '10.0.0', ...npm },
    python: { ...base, version: '3.12.0' },
  }
}

describe('nodeRuntimeReady', () => {
  it('accepts a supported Node with npm present', () => {
    expect(nodeRuntimeReady(runtime({}))).toBe(true)
    expect(cliRuntimeBlockMessage(runtime({}))).toBeNull()
  })

  it('rejects a version the scan could not read, which reports tooOld as false', () => {
    const unreadable = runtime({ version: 'nodejs custom build', tooOld: false, versionStatus: 'unknown' })
    expect(nodeRuntimeReady(unreadable)).toBe(false)
    expect(cliRuntimeBlockMessage(unreadable)).toContain('版本无法识别')
  })

  it('rejects a version below the supported floor', () => {
    const old = runtime({ version: 'v18.20.0', tooOld: true, versionStatus: 'too-old' })
    expect(nodeRuntimeReady(old)).toBe(false)
    expect(cliRuntimeBlockMessage(old)).toContain('版本过低')
    expect(cliRuntimeBlockMessage(old)).toContain('v18.20.0')
  })

  it('rejects a missing Node or a missing npm before it looks at the version', () => {
    expect(nodeRuntimeReady(runtime({ installed: false, version: null, versionStatus: 'unknown' }))).toBe(false)
    expect(cliRuntimeBlockMessage(runtime({ installed: false, version: null, versionStatus: 'unknown' }))).toContain('请先准备 Node.js 运行环境')
    expect(nodeRuntimeReady(runtime({}, { installed: false, version: null }))).toBe(false)
    expect(cliRuntimeBlockMessage(runtime({}, { installed: false, version: null }))).toContain('请先准备 Node.js 运行环境')
  })

  it('stays ready when an older snapshot carries no versionStatus at all', () => {
    expect(nodeRuntimeReady(runtime({ versionStatus: undefined }))).toBe(true)
  })
})

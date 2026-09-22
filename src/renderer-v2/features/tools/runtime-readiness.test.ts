import { describe, expect, it } from 'vitest'
import type { SystemSnapshot } from '../../../../electron/ipc-contract'
import { cliInstallStageLabel, cliRuntimeBlockMessage, nodeRuntimeReady, planCliInstall, runtimeStageFailureMessage } from './runtime-readiness'

const base = { installed: true, version: '1.0.0', path: null, installDirectory: null }

function runtime(node: Partial<SystemSnapshot['runtime']['node']>, npm: Partial<SystemSnapshot['runtime']['npm']> = {}): SystemSnapshot['runtime'] {
  return {
    node: { ...base, version: 'v22.0.0', tooOld: false, versionStatus: 'supported', ...node },
    npm: { ...base, version: '10.0.0', ...npm },
    python: { ...base, version: '3.12.0' },
    git: { ...base, version: '2.43.0' },
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

  it('no longer tells the user about PATH or LTS', () => {
    const unreadable = runtime({ version: 'nodejs custom build', tooOld: false, versionStatus: 'unknown' })
    expect(cliRuntimeBlockMessage(unreadable)).not.toMatch(/PATH|LTS/)
  })
})

describe('planCliInstall', () => {
  const managed = { nodeInstall: 'managed', pythonInstall: 'managed' } as const
  const external = { nodeInstall: 'external', pythonInstall: 'external' } as const
  const missingNode = runtime({ installed: false, version: null, versionStatus: 'unknown' })

  it('installs straight away when everything is ready', () => {
    expect(planCliInstall({ runtime: runtime({}), needsPython: true, ...managed })).toEqual({ prepare: [], blocked: null })
  })

  it('folds a missing, too old or unreadable Node into the same install where the app can install it', () => {
    expect(planCliInstall({ runtime: missingNode, needsPython: false, ...managed })).toEqual({ prepare: ['node'], blocked: null })
    expect(planCliInstall({ runtime: runtime({ tooOld: true, versionStatus: 'too-old' }), needsPython: false, ...managed })).toEqual({ prepare: ['node'], blocked: null })
    expect(planCliInstall({ runtime: runtime({ versionStatus: 'unknown' }), needsPython: false, ...managed })).toEqual({ prepare: ['node'], blocked: null })
  })

  it('prepares Node before Python for Gemini', () => {
    const bare = { ...missingNode, python: { ...missingNode.python, installed: false, version: null } }
    expect(planCliInstall({ runtime: bare, needsPython: true, ...managed })).toEqual({ prepare: ['node', 'python'], blocked: null })
    const failedProbe = { ...runtime({}), python: { ...runtime({}).python, detectionFailed: true } }
    expect(planCliInstall({ runtime: failedProbe, needsPython: true, ...managed })).toEqual({ prepare: ['python'], blocked: null })
    expect(planCliInstall({ runtime: failedProbe, needsPython: false, ...managed })).toEqual({ prepare: [], blocked: null })
  })

  it('still blocks where the app cannot install the runtime, and says which step', () => {
    expect(planCliInstall({ runtime: missingNode, needsPython: false, ...external })).toEqual({ prepare: [], blocked: '请先准备 Node.js 运行环境，再安装命令行工具。' })
    expect(planCliInstall({ runtime: missingNode, needsPython: false, nodeInstall: undefined, pythonInstall: undefined }).blocked).toContain('Node.js')
    const noPython = { ...runtime({}), python: { ...runtime({}).python, installed: false } }
    expect(planCliInstall({ runtime: noPython, needsPython: true, ...external }).blocked).toContain('Python')
  })
})

describe('install stage wording', () => {
  it('numbers each stage out of the whole install', () => {
    expect(cliInstallStageLabel('node', 0, 2, 'Claude Code')).toBe('正在准备 Node.js 运行环境（1/2）')
    expect(cliInstallStageLabel('python', 1, 3, 'Gemini CLI')).toBe('正在准备 Python 运行环境（2/3）')
    expect(cliInstallStageLabel('tool', 2, 3, 'Gemini CLI')).toBe('正在安装 Gemini CLI（3/3）')
  })

  it('says the runtime failed and the tool never started, keeping the raw cause for classification', () => {
    const message = runtimeStageFailureMessage('node', 'Claude Code', 'ETIMEDOUT registry.npmmirror.com')
    expect(message).toMatch(/^Node\.js 运行环境没装上，Claude Code 还没开始安装。/)
    expect(message).toContain('ETIMEDOUT')
  })
})

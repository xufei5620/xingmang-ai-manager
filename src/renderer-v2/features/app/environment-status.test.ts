import { describe, expect, it } from 'vitest'
import { buildEnvironmentStatus, environmentRuntimeSummary } from './environment-status'

const installed = (version: string) => ({ installed: true, version })
const missing = { installed: false, version: null }

describe('renderer-v2 status bar environment', () => {
  it('stays grey until a check has run', () => {
    expect(buildEnvironmentStatus(null)).toEqual({ tone: 'neutral', label: '环境待检测', detail: undefined })
  })

  it('counts only the findings the health page marks as pending, like the startup notice', () => {
    expect(buildEnvironmentStatus({ warn: 3, fail: 1, error: 1 })).toMatchObject({ tone: 'warn', label: '环境有 2 项需要处理' })
    expect(buildEnvironmentStatus({ warn: 5, fail: 0, error: 0 })).toMatchObject({ tone: 'ok', label: '环境正常' })
  })

  it('lists every runtime on hover and says which ones are missing', () => {
    const runtimes = { node: installed('v24.0.0'), python: missing, git: installed('2.43.0') }
    expect(environmentRuntimeSummary(runtimes)).toBe('Node.js v24.0.0 · Python 没装 · Git 2.43.0')
    expect(buildEnvironmentStatus({ warn: 0, fail: 0, error: 0 }, runtimes).detail).toBe('Node.js v24.0.0 · Python 没装 · Git 2.43.0')
  })

  it('does not call a runtime missing when its probe failed', () => {
    expect(environmentRuntimeSummary({ node: { installed: false, version: null, detectionFailed: true }, python: missing, git: missing }))
      .toBe('Node.js 检测失败 · Python 没装 · Git 没装')
  })
})

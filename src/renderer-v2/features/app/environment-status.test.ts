import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  buildEnvironmentStatus,
  diagnosticsRevision,
  environmentJobsFinished,
  environmentRuntimeSummary,
  markDiagnosticsStale,
  publishDiagnosticsCounts,
  useDiagnosticsCounts,
  useDiagnosticsRevision,
} from './environment-status'

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

// 状态栏读的是模块里那一份，这里照它的读法挂一个最小的组件读出来。
function StatusProbe() {
  const label = buildEnvironmentStatus(useDiagnosticsCounts()).label
  return createElement('span', { 'data-revision': useDiagnosticsRevision() }, label)
}

function statusBar() {
  return renderToStaticMarkup(createElement(StatusProbe))
}

describe('renderer-v2 status bar after the environment changed', () => {
  it('drops back to the grey not-checked state once something was installed or changed', () => {
    publishDiagnosticsCounts({ warn: 0, fail: 2, error: 0 })
    expect(statusBar()).toContain('环境有 2 项需要处理')
    markDiagnosticsStale()
    expect(statusBar()).toContain('环境待检测')
  })

  it('does not take the counts of a check that started before the change', () => {
    const started = diagnosticsRevision()
    markDiagnosticsStale()
    publishDiagnosticsCounts({ warn: 0, fail: 1, error: 0 }, started)
    expect(statusBar()).toContain('环境待检测')
    publishDiagnosticsCounts({ warn: 0, fail: 0, error: 0 }, diagnosticsRevision())
    expect(statusBar()).toContain('环境正常')
  })

  it('publishes as before when the caller does not say when its check started', () => {
    markDiagnosticsStale()
    publishDiagnosticsCounts({ warn: 0, fail: 1, error: 0 })
    expect(statusBar()).toContain('环境有 1 项需要处理')
  })

  it('tells the health page that the environment changed', () => {
    const before = diagnosticsRevision()
    expect(statusBar()).toContain(`data-revision="${before}"`)
    markDiagnosticsStale()
    expect(statusBar()).toContain(`data-revision="${before + 1}"`)
  })
})

describe('renderer-v2 tool jobs that change the environment', () => {
  it('counts installs, uninstalls, runtimes, source switches and hook repairs once they end', () => {
    expect(environmentJobsFinished(['claude'], [])).toBe(true)
    expect(environmentJobsFinished(['node', 'launch:codex'], ['launch:codex'])).toBe(true)
    expect(environmentJobsFinished(['switch:codex'], [])).toBe(true)
    expect(environmentJobsFinished(['repair-hooks:claude'], [])).toBe(true)
  })

  it('ignores launches and jobs that are still running or just started', () => {
    expect(environmentJobsFinished(['launch:claude'], [])).toBe(false)
    expect(environmentJobsFinished(['claude'], ['claude', 'launch:codex'])).toBe(false)
    expect(environmentJobsFinished([], ['claude'])).toBe(false)
  })
})

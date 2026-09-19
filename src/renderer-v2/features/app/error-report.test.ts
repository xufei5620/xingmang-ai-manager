import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRuntimeErrorReporter } from './error-report'
import type { RendererErrorPayload } from '../../../../electron/ipc-contract'

function recorder() {
  const reports: RendererErrorPayload[] = []
  return {
    reports,
    native: {
      reportRendererError: async (payload: RendererErrorPayload) => {
        reports.push(payload)
      },
    },
  }
}

describe('renderer-v2 runtime error reporting', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports the first failure at once and closes the window with the repeat count', () => {
    const { native, reports } = recorder()
    const reporter = createRuntimeErrorReporter(native)
    for (let attempt = 0; attempt < 4; attempt += 1) reporter.report(new Error('请求失败'), 'renderer-v2 window.error')
    expect(reports.map((report) => report.message)).toEqual(['请求失败'])
    vi.advanceTimersByTime(30000)
    expect(reports.map((report) => report.message)).toEqual(['请求失败', '请求失败（随后 30 秒内重复 3 次）'])
  })

  it('adds no summary when the failure never repeats', () => {
    const { native, reports } = recorder()
    const reporter = createRuntimeErrorReporter(native)
    reporter.report(new Error('只发生一次'), 'renderer-v2 window.error')
    vi.advanceTimersByTime(30000)
    expect(reports.map((report) => report.message)).toEqual(['只发生一次'])
  })

  it('reports live again once the previous window has closed', () => {
    const { native, reports } = recorder()
    const reporter = createRuntimeErrorReporter(native)
    reporter.report(new Error('请求失败'), 'renderer-v2 window.error')
    vi.advanceTimersByTime(30000)
    reporter.report(new Error('请求失败'), 'renderer-v2 window.error')
    expect(reports.map((report) => report.message)).toEqual(['请求失败', '请求失败'])
  })

  it('counts the same message separately per context', () => {
    const { native, reports } = recorder()
    const reporter = createRuntimeErrorReporter(native)
    reporter.report(new Error('请求失败'), 'renderer-v2 window.error')
    reporter.report(new Error('请求失败'), 'renderer-v2 unhandledrejection')
    reporter.report(new Error('请求失败'), 'renderer-v2 unhandledrejection')
    vi.advanceTimersByTime(30000)
    expect(reports.map((report) => `${report.context}|${report.message}`)).toEqual([
      'renderer-v2 window.error|请求失败',
      'renderer-v2 unhandledrejection|请求失败',
      'renderer-v2 unhandledrejection|请求失败（随后 30 秒内重复 1 次）',
    ])
  })

  it('keeps a non-Error rejection readable and carries the stack of the first occurrence', () => {
    const { native, reports } = recorder()
    const reporter = createRuntimeErrorReporter(native)
    reporter.report('字符串异常', 'renderer-v2 unhandledrejection')
    reporter.report({ unexpected: true }, 'renderer-v2 unhandledrejection')
    expect(reports.map((report) => report.message)).toEqual(['字符串异常', '界面异步操作发生异常'])
    expect(reports.every((report) => report.stack === undefined)).toBe(true)
  })

  it('drops pending windows on dispose so a teardown reports nothing later', () => {
    const { native, reports } = recorder()
    const reporter = createRuntimeErrorReporter(native)
    reporter.report(new Error('请求失败'), 'renderer-v2 window.error')
    reporter.report(new Error('请求失败'), 'renderer-v2 window.error')
    reporter.dispose()
    vi.advanceTimersByTime(30000)
    expect(reports.map((report) => report.message)).toEqual(['请求失败'])
  })
})

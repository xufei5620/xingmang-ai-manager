import fc from 'fast-check'
import { describe, expect, it, vi } from 'vitest'
import { buildCrashReportEvent, type CrashReportEnvironment } from './crash-report'
import {
  buildMainHangStack,
  collectRendererCallStack,
  hangReportSampleRate,
  mainHangReportInput,
  normalizeRendererCallStack,
  parseMainHangCapture,
  rendererHangReportInput,
  shouldReportHangsThisSession,
  type MainHangFrame,
} from './hang-report'

const runtime: CrashReportEnvironment = {
  release: 'xingmang-ai-manager@9.9.9',
  dist: 'win32-x64',
  environment: 'production',
  homeDirectory: 'C:\\Users\\yoyo',
  appVersion: '9.9.9',
  electronVersion: '45.4.1',
  nodeVersion: '24.0.0',
  osPlatform: 'win32',
  osRelease: '10.0.22631',
  arch: 'x64',
}

const fixedNow = new Date('2026-11-20T08:00:00.000Z')
const asar = 'file:///D:/Program%20Files/xingmang/resources/app.asar'

function frame(overrides: Partial<MainHangFrame> = {}): MainHangFrame {
  return { functionName: 'readEverything', url: `${asar}/dist-electron/system-service.js`, lineNumber: 41, columnNumber: 9, ...overrides }
}

describe('parseMainHangCapture', () => {
  it('reads the message the watchdog worker posts', () => {
    expect(parseMainHangCapture({ type: 'hang', stalledMs: 6200.5, frames: [frame()], afterRecovery: false }))
      .toEqual({ stalledMs: 6200.5, frames: [frame()], afterRecovery: false })
  })

  it('drops anything malformed whole instead of reporting half of it', () => {
    const good = { type: 'hang', stalledMs: 6000, frames: [frame()], afterRecovery: false }
    expect(parseMainHangCapture(null)).toBeNull()
    expect(parseMainHangCapture([good])).toBeNull()
    expect(parseMainHangCapture({ ...good, type: 'failed' })).toBeNull()
    expect(parseMainHangCapture({ ...good, stalledMs: -1 })).toBeNull()
    expect(parseMainHangCapture({ ...good, stalledMs: Number.NaN })).toBeNull()
    expect(parseMainHangCapture({ ...good, afterRecovery: 'no' })).toBeNull()
    expect(parseMainHangCapture({ ...good, frames: 'at x' })).toBeNull()
    expect(parseMainHangCapture({ ...good, frames: [frame({ functionName: 'a\nb' })] })).toBeNull()
    expect(parseMainHangCapture({ ...good, frames: [frame({ url: 'x'.repeat(2049) })] })).toBeNull()
    expect(parseMainHangCapture({ ...good, frames: [frame({ lineNumber: 1.5 })] })).toBeNull()
    expect(parseMainHangCapture({ ...good, frames: [frame({ columnNumber: -1 })] })).toBeNull()
  })

  it('keeps at most sixty frames, the same cap crash reports parse', () => {
    const frames = Array.from({ length: 80 }, (_, index) => frame({ lineNumber: index }))
    expect(parseMainHangCapture({ type: 'hang', stalledMs: 1, frames, afterRecovery: false })?.frames).toHaveLength(60)
  })
})

describe('buildMainHangStack', () => {
  it('writes inspector frames as a V8 stack with 1-based positions', () => {
    expect(buildMainHangStack([
      frame(),
      frame({ functionName: '', url: `${asar}/dist-electron/main.js`, lineNumber: 0, columnNumber: 0 }),
      frame({ functionName: 'listOnTimeout', url: 'node:internal/timers', lineNumber: 580, columnNumber: 16 }),
    ])).toBe([
      `    at readEverything (${asar}/dist-electron/system-service.js:42:10)`,
      `    at ${asar}/dist-electron/main.js:1:1`,
      '    at listOnTimeout (node:internal/timers:581:17)',
    ].join('\n'))
  })

  it('leaves out frames that have no script to point at', () => {
    expect(buildMainHangStack([frame({ url: '' }), frame()])).toBe(`    at readEverything (${asar}/dist-electron/system-service.js:42:10)`)
  })
})

describe('mainHangReportInput', () => {
  it('becomes a warning whose frames match the uploaded source maps', () => {
    const event = buildCrashReportEvent(mainHangReportInput({ stalledMs: 7012.4, frames: [frame()], afterRecovery: false }), runtime, fixedNow, 'e'.repeat(32))
    expect(event.level).toBe('warning')
    expect(event.logger).toBe('main')
    expect(event.tags.mechanism).toBe('main-hang')
    expect(event.exception.values[0].type).toBe('MainProcessHang')
    expect(event.exception.values[0].value).toBe('主进程卡住 5 秒以上')
    expect(event.exception.values[0].stacktrace?.frames).toEqual([{
      filename: 'app:///dist-electron/system-service.js',
      abs_path: 'app:///dist-electron/system-service.js',
      function: 'readEverything',
      lineno: 42,
      colno: 10,
      in_app: true,
    }])
    expect(event.extra).toEqual({ context: 'stalledMs=7012' })
  })

  it('says when the frames were taken only after the main thread had moved on', () => {
    const input = mainHangReportInput({ stalledMs: 5000, frames: [frame()], afterRecovery: true })
    expect(input.context).toContain('capturedAfterRecovery')
  })

  it('redacts a home directory that reaches a frame like any crash report', () => {
    const event = buildCrashReportEvent(mainHangReportInput({
      stalledMs: 5000,
      frames: [frame({ url: 'C:\\Users\\yoyo\\AppData\\Local\\custom.js' })],
      afterRecovery: false,
    }), runtime, fixedNow)
    expect(JSON.stringify(event)).not.toContain('yoyo')
  })

  it('never carries a line break inside a frame or more than sixty frames, whatever the worker sends, with random inputs', () => {
    const text = fc.string({ maxLength: 40 })
    const rawFrame = fc.record({ functionName: text, url: text, lineNumber: fc.integer({ min: -2, max: 1e6 }), columnNumber: fc.integer({ min: -2, max: 1e6 }) })
    fc.assert(fc.property(fc.array(rawFrame, { maxLength: 90 }), fc.double(), fc.boolean(), (frames, stalledMs, afterRecovery) => {
      const capture = parseMainHangCapture({ type: 'hang', stalledMs, frames, afterRecovery })
      if (!capture) return
      const stack = buildMainHangStack(capture.frames)
      const lines = stack === '' ? [] : stack.split('\n')
      expect(lines.length).toBeLessThanOrEqual(60)
      for (const line of lines) expect(line.startsWith('    at ')).toBe(true)
    }), { numRuns: 300 })
  })
})

describe('renderer hang reports', () => {
  it('keeps only the frames of what collectJavaScriptCallStack returns', () => {
    expect(normalizeRendererCallStack('\n    at Math.random (<anonymous>)\n    at loop (xingmang://app/assets/index-1a2b.js:2:111)\nsomething the page wrote'))
      .toBe('    at Math.random (<anonymous>)\n    at loop (xingmang://app/assets/index-1a2b.js:2:111)')
    expect(normalizeRendererCallStack(undefined)).toBeNull()
    expect(normalizeRendererCallStack('no frames here')).toBeNull()
  })

  it('becomes a warning whose frames point at the renderer bundle', () => {
    const event = buildCrashReportEvent(rendererHangReportInput('    at loop (xingmang://app/assets/index-1a2b.js:2:111)'), runtime, fixedNow)
    expect(event.level).toBe('warning')
    expect(event.tags).toMatchObject({ process: 'renderer', mechanism: 'renderer-hang' })
    expect(event.exception.values[0]).toMatchObject({ type: 'RendererHang', value: '界面卡住没响应' })
    expect(event.exception.values[0].stacktrace?.frames).toEqual([expect.objectContaining({ filename: 'app:///dist/assets/index-1a2b.js', function: 'loop', lineno: 2, colno: 111 })])
  })
})

describe('collectRendererCallStack', () => {
  it('hands back the frames the frame reports', async () => {
    await expect(collectRendererCallStack({ collectJavaScriptCallStack: async () => '\n    at loop (xingmang://app/a.js:1:2)' }))
      .resolves.toBe('    at loop (xingmang://app/a.js:1:2)')
  })

  it('gives up after the timeout when the page runs no JavaScript and the promise never settles', async () => {
    vi.useFakeTimers()
    try {
      const pending = collectRendererCallStack({ collectJavaScriptCallStack: () => new Promise<string>(() => undefined) }, 3000)
      await vi.advanceTimersByTimeAsync(3000)
      await expect(pending).resolves.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('never rejects, whether the call throws, rejects or returns nothing', async () => {
    await expect(collectRendererCallStack({ collectJavaScriptCallStack: () => { throw new Error('destroyed') } })).resolves.toBeNull()
    await expect(collectRendererCallStack({ collectJavaScriptCallStack: () => Promise.reject(new Error('gone')) })).resolves.toBeNull()
    await expect(collectRendererCallStack({ collectJavaScriptCallStack: async () => undefined })).resolves.toBeNull()
  })
})

describe('shouldReportHangsThisSession', () => {
  it('lets the sampled share of sessions through and no more', () => {
    expect(shouldReportHangsThisSession(0)).toBe(true)
    expect(shouldReportHangsThisSession(hangReportSampleRate - 0.0001)).toBe(true)
    expect(shouldReportHangsThisSession(hangReportSampleRate)).toBe(false)
    expect(shouldReportHangsThisSession(0.999)).toBe(false)
  })
})

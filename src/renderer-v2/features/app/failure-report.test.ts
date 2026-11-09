import { describe, expect, it } from 'vitest'
import type { RendererErrorPayload, XingmangApi } from '../../../../electron/ipc-contract'
import { parseRendererError } from '../../../../electron/ipc/parsers/system'
import { FailureBoundary } from './FailureBoundary'
import { buildFailureBoundaryReport } from './failure-report'

// Shaped like the minified React 19 production build: the component that threw
// comes first, one "at Name (asset:line:col)" frame per level, host elements
// without a location. A six-level tree already measured 371 characters.
function productionComponentStack(depth: number): string {
  const frames: string[] = []
  for (let level = 0; level < depth; level += 1) {
    frames.push(level % 4 === 3 ? '    at div' : `    at ${String.fromCharCode(65 + (level % 26))}${level} (xingmang://app/assets/index-C1x9QvZk.js:9:${61234 + level * 917})`)
  }
  return `\n${frames.join('\n')}`
}

describe('renderer-v2 failure boundary report', () => {
  it('fits a real-depth component stack under the main-process cap instead of losing the report', () => {
    const componentStack = productionComponentStack(40)
    expect(componentStack.length).toBeGreaterThan(1500)
    const error = new TypeError("Cannot read properties of undefined (reading 'map')")

    const report = buildFailureBoundaryReport(error, componentStack)
    const parsed = parseRendererError(report)

    expect(parsed.context!.length).toBeLessThanOrEqual(256)
    expect(parsed.message).toBe("Cannot read properties of undefined (reading 'map')")
    expect(parsed.stack).toBe(error.stack)
    expect(parsed.level).toBe('error')
  })

  it('keeps whole frames from the component that threw outward', () => {
    const componentStack = productionComponentStack(40)
    const frames = componentStack.split('\n').map((line) => line.trim()).filter(Boolean)

    const [label, ...kept] = buildFailureBoundaryReport(new Error('Boom'), componentStack).context!.split('\n')

    expect(label).toBe('renderer-v2 error-boundary')
    expect(kept.length).toBeGreaterThan(2)
    expect(kept).toEqual(frames.slice(0, kept.length))
  })

  it('cuts a single oversized frame rather than dropping the component stack', () => {
    const report = buildFailureBoundaryReport(new Error('Boom'), `\n    at ${'X'.repeat(600)} (xingmang://app/assets/index.js:1:1)`)

    expect(() => parseRendererError(report)).not.toThrow()
    expect(report.context!.length).toBe(256)
    expect(report.context!.startsWith('renderer-v2 error-boundary\nat XXX')).toBe(true)
  })

  it('labels the report when React gives no component stack', () => {
    expect(buildFailureBoundaryReport(new Error('Boom'), null).context).toBe('renderer-v2 error-boundary')
    expect(buildFailureBoundaryReport(new Error('Boom')).context).toBe('renderer-v2 error-boundary')
  })

  it('still sends a report the main process accepts for an empty message or a thrown non-Error', () => {
    for (const thrown of [new Error(''), new Error('   '), null, undefined, { code: 1 }]) {
      const parsed = parseRendererError(buildFailureBoundaryReport(thrown, productionComponentStack(3)))
      expect(parsed.message).toBe('界面渲染发生异常')
    }
    expect(parseRendererError(buildFailureBoundaryReport('页面数据缺失', null)).message).toBe('页面数据缺失')
  })

  it('drops NUL characters so one stray byte cannot void the report', () => {
    const error = new Error('bad\0value')
    error.stack = `Error: bad\0value\n    at render (xingmang://app/assets/index.js:1:1)`

    const parsed = parseRendererError(buildFailureBoundaryReport(error, `\n    at Na\0me (xingmang://app/assets/index.js:2:2)`))

    expect(parsed.message).toBe('badvalue')
    expect(parsed.stack).not.toContain('\0')
    expect(parsed.context).toBe('renderer-v2 error-boundary\nat Name (xingmang://app/assets/index.js:2:2)')
  })

  it('keeps an overlong message and stack inside the main-process caps', () => {
    const error = new Error('m'.repeat(5000))
    error.stack = 's'.repeat(20000)

    const parsed = parseRendererError(buildFailureBoundaryReport(error, productionComponentStack(40)))

    expect(parsed.message.length).toBe(2000)
    expect(parsed.stack!.length).toBe(6000)
  })

  it('hands the fitted report to the main process when the boundary catches a render failure', async () => {
    const reports: RendererErrorPayload[] = []
    const native = { reportRendererError: async (payload: RendererErrorPayload) => { reports.push(payload) } } as unknown as XingmangApi
    const boundary = new FailureBoundary({ native, children: null })
    const error = new Error('Boom')
    const componentStack = productionComponentStack(40)

    boundary.componentDidCatch(error, { componentStack })
    await Promise.resolve()

    expect(reports).toHaveLength(1)
    expect(() => parseRendererError(reports[0])).not.toThrow()
    expect(reports[0]).toEqual(buildFailureBoundaryReport(error, componentStack))
  })
})

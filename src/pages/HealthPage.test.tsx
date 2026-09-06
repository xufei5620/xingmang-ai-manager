import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { HealthPage, type HealthReport } from './HealthPage'

const report: HealthReport = { version: 1, generatedAt: '2026-09-07T00:00:00Z', durationMs: 15, counts: { pass: 1, warn: 0, fail: 1, error: 0 }, items: [
  { code: 'APP_RUNTIME', title: '应用环境', state: 'pass', summary: '运行正常', durationMs: 5 },
  { code: 'RUNTIME_NODE', title: 'Node.js', state: 'fail', summary: '版本过低', durationMs: 10, details: { version: '16.0.0' } },
] }
describe('HealthPage', () => {
  it('keeps all report details and adds a resolver only for an actionable result', () => {
    const markup = renderToStaticMarkup(<HealthPage api={{ run: vi.fn(), exportLatest: vi.fn() }} initialReport={report} onResolve={vi.fn()} />)
    expect(markup.match(/去处理/g)).toHaveLength(1)
    expect(markup).toContain('16.0.0')
    expect(markup).toContain('检查详情')
    expect(markup).toContain('data-page-id="health"')
  })

  it('keeps legacy integrations without a resolver usable', () => {
    const markup = renderToStaticMarkup(<HealthPage api={{ run: vi.fn(), exportLatest: vi.fn() }} initialReport={report} />)
    expect(markup).not.toContain('去处理')
    expect(markup).toContain('开始检查')
    expect(markup).toContain('导出报告')
  })
})

import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { CanvasRunPreflight } from '../runtime/run-preflight'
import type { CanvasRunQuoteView } from '../runtime/run-quote'
import { RunPreflight } from './RunPreflight'

// 运行前检查「这次最多扣费生成 N 次」后面接「预计约 $x」（桌面仓画布完善第 2b 条第 2 步）。

const preflight: CanvasRunPreflight = {
  scope: { kind: 'all' }, selectedNodeIds: ['image'], groups: ['图片模型'], models: ['gpt-image-2'],
  items: [{ nodeId: 'image', kind: 'image-generate', action: 'execute', paid: true, requestCount: 3, group: '图片模型', model: 'gpt-image-2' }],
  requestCount: 3, cacheHitCount: 0, skippedCount: 0, blockedCount: 0, paidRequestCount: 3, imageRequestCount: 3, videoRequestCount: 0,
  textRequestCount: 0, webSearchRequestCount: 0, risk: 'warning', warnings: ['这次最多扣费生成 3 次；发出去没收到结果的不会自动重发'], canStart: true,
}

function markup(quote?: CanvasRunQuoteView | null) {
  return renderToStaticMarkup(createElement(RunPreflight, { preflight, quote, onCancel: vi.fn(), onConfigure: vi.fn(), onLocateNode: vi.fn(), onConfirm: vi.fn() }))
}

describe('run preflight quote', () => {
  it('follows the paid count with the estimate', () => {
    const html = markup({ state: 'ready', quote: { estimateUsd: 0.18, pricedRequests: 3, unknownRequests: 0, approximate: false } })
    expect(html).toContain('这次最多扣费生成 3 次，<span class="run-preflight-quote" title="按你账号的价目和分组倍率算的最多花费，实际扣多少以站点为准" aria-live="polite">预计约 $0.18</span>。输入跟上次一样的直接用上次的结果，不扣费。')
  })

  it('says it is working, or that the price is unknown, and keeps the old sentence where the host has no price list', () => {
    expect(markup({ state: 'loading' })).toContain('>正在算预计多少钱</span>。')
    expect(markup({ state: 'ready', quote: { estimateUsd: 0, pricedRequests: 0, unknownRequests: 3, approximate: false } })).toContain('>价格未知</span>。')
    expect(markup(null)).toContain('这次最多扣费生成 3 次。输入跟上次一样的直接用上次的结果，不扣费。')
    expect(markup()).not.toContain('run-preflight-quote')
  })

  it('asks for prices only where the host offers them', () => {
    const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
    expect(app).toContain('const runQuote = useCanvasRunQuote(runPreflight, hostEntryPoints.quote)')
    expect(app).toContain('quote={runQuote}')
  })
})

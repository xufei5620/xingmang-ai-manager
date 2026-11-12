import { describe, expect, it } from 'vitest'
import type { CanvasPriceSnapshot } from '../host'
import type { CanvasRunPreflightItem } from './run-preflight'
import { buildCanvasRunQuote, canvasRunQuoteText, parseCanvasPriceSnapshot, readCanvasPriceSnapshot } from './run-quote'

const snapshot: CanvasPriceSnapshot = {
  models: { 'gpt-image-2': { usd: 0.06 }, 'nano-banana-2': { usd: 0.04, approximate: true }, cheap: { usd: 0.001 } },
  groupRatios: { 图片模型: 1, 便宜分组: 0.5 },
  readAt: '2026-11-10T03:00:00.000Z',
}

function item(overrides: Partial<CanvasRunPreflightItem>): CanvasRunPreflightItem {
  return { nodeId: 'n', kind: 'image-generate', action: 'execute', paid: true, requestCount: 1, group: '图片模型', model: 'gpt-image-2', ...overrides }
}

describe('canvas run quote', () => {
  it('reads the documented price list and treats null as unpriced', () => {
    expect(parseCanvasPriceSnapshot(snapshot)).toEqual(snapshot)
    expect(parseCanvasPriceSnapshot(null)).toBeNull()
  })

  it('rejects price lists that are not the documented shape', () => {
    for (const value of [undefined, 'x', [], {}, { ...snapshot, readAt: 'later' }, { ...snapshot, models: [] },
      { ...snapshot, models: { a: { usd: -1 } } }, { ...snapshot, models: { a: { usd: 5000 } } }, { ...snapshot, models: { a: { usd: '0.1' } } },
      { ...snapshot, models: { a: { usd: 0.1, approximate: 'yes' } } }, { ...snapshot, models: { ['m'.repeat(129)]: { usd: 0.1 } } },
      { ...snapshot, groupRatios: { a: Number.NaN } }, { ...snapshot, groupRatios: { a: -1 } }, { ...snapshot, groupRatios: { '': 1 } },
      { ...snapshot, models: Object.fromEntries(Array.from({ length: 2001 }, (_, index) => [`m${index}`, { usd: 0.1 }])) }]) {
      expect(() => parseCanvasPriceSnapshot(value), JSON.stringify(value)?.slice(0, 80)).toThrow('价目格式不对')
    }
  })

  it('prices nothing when the host has no list, fails or answers nonsense', async () => {
    await expect(readCanvasPriceSnapshot(undefined)).resolves.toBeNull()
    await expect(readCanvasPriceSnapshot(async () => { throw new Error('网络断了') })).resolves.toBeNull()
    await expect(readCanvasPriceSnapshot(async () => ({ models: 3 }))).resolves.toBeNull()
    await expect(readCanvasPriceSnapshot(async () => null)).resolves.toBeNull()
    await expect(readCanvasPriceSnapshot(async () => snapshot)).resolves.toEqual(snapshot)
  })

  it('multiplies price, group ratio and the maximum count of every paid request', () => {
    const quote = buildCanvasRunQuote({ items: [item({ requestCount: 3 }), item({ nodeId: 'b', group: '便宜分组' })] }, snapshot)
    expect(quote).toEqual({ estimateUsd: expect.closeTo(0.21, 10), pricedRequests: 4, unknownRequests: 0, approximate: false })
    expect(canvasRunQuoteText({ state: 'ready', quote: quote! })).toBe('预计约 $0.21')
  })

  it('leaves out cached, skipped, blocked and local work', () => {
    const items = [item({ action: 'cached', requestCount: 0 }), item({ action: 'skip', requestCount: 0 }), item({ action: 'blocked', requestCount: 0 }), item({ paid: false, kind: 'image-crop' })]
    expect(buildCanvasRunQuote({ items }, snapshot)).toBeNull()
  })

  it('counts requests it cannot price instead of guessing', () => {
    const quote = buildCanvasRunQuote({ items: [item({}), item({ model: 'unlisted', requestCount: 2 }), item({ group: '没有的分组' }), item({ model: undefined })] }, snapshot)!
    expect(quote).toMatchObject({ pricedRequests: 1, unknownRequests: 4 })
    expect(canvasRunQuoteText({ state: 'ready', quote })).toBe('预计约 $0.06，另有 4 次价格未知')
    // Prototype keys are not prices.
    expect(buildCanvasRunQuote({ items: [item({ model: 'constructor', group: 'constructor' })] }, snapshot)).toMatchObject({ pricedRequests: 0, unknownRequests: 1 })
  })

  it('says 价格未知 when the host cannot price the account at all', () => {
    const quote = buildCanvasRunQuote({ items: [item({ requestCount: 2 })] }, null)!
    expect(quote).toEqual({ estimateUsd: 0, pricedRequests: 0, unknownRequests: 2, approximate: false })
    expect(canvasRunQuoteText({ state: 'ready', quote })).toBe('价格未知')
  })

  it('marks an estimate, never shows a small charge as free, and says it is working while it asks', () => {
    expect(canvasRunQuoteText({ state: 'ready', quote: buildCanvasRunQuote({ items: [item({ model: 'nano-banana-2' })] }, snapshot)! })).toBe('预计约 $0.04（估算）')
    expect(canvasRunQuoteText({ state: 'ready', quote: buildCanvasRunQuote({ items: [item({ model: 'cheap' })] }, snapshot)! })).toBe('预计不到 $0.01')
    expect(canvasRunQuoteText({ state: 'ready', quote: { estimateUsd: 0, pricedRequests: 1, unknownRequests: 0, approximate: false } })).toBe('预计约 $0.00')
    expect(canvasRunQuoteText({ state: 'loading' })).toBe('正在算预计多少钱')
  })
})

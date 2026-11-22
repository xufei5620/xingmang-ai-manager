import { describe, expect, it } from 'vitest'
import type { AccountPriceList } from '../../../../electron/ipc-contract'
import { createVideoStudioPriceCache, videoStudioPerCallUsd, videoStudioPriceListMaxAgeMs, videoStudioPriceListRetryMs, videoStudioQuoteText } from './prices'

const list: AccountPriceList = { rows: [
  { model: 'grok-imagine-video-1.5', group: '图片模型', kind: 'call', perCall: 0.8 },
  { model: 'grok-imagine-video-1.5', group: 'VIP', kind: 'call', perCall: 0.4 },
  { model: 'gpt-image-2', group: '图片模型', kind: 'token', input: 10, output: 40 },
  { model: 'minimax-h3-base', group: '图片模型', kind: 'tiered' },
] }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('video studio prices', () => {
  it('takes the per-call price of the model in the group the clip is billed to', () => {
    expect(videoStudioPerCallUsd(list, 'grok-imagine-video-1.5', '图片模型')).toBe(0.8)
    expect(videoStudioPerCallUsd(list, 'grok-imagine-video-1.5', 'VIP')).toBe(0.4)
  })

  it('has no price for a model priced by tokens or in tiers, for another group, or without a list', () => {
    expect(videoStudioPerCallUsd(list, 'gpt-image-2', '图片模型')).toBeNull()
    expect(videoStudioPerCallUsd(list, 'minimax-h3-base', '图片模型')).toBeNull()
    expect(videoStudioPerCallUsd(list, 'grok-imagine-video-1.5', 'GPT')).toBeNull()
    expect(videoStudioPerCallUsd(list, '', '图片模型')).toBeNull()
    expect(videoStudioPerCallUsd(list, 'grok-imagine-video-1.5', '')).toBeNull()
    expect(videoStudioPerCallUsd(null, 'grok-imagine-video-1.5', '图片模型')).toBeNull()
    expect(videoStudioPerCallUsd({ rows: [{ model: 'm', group: 'g', kind: 'call', perCall: Number.NaN }] }, 'm', 'g')).toBeNull()
    expect(videoStudioPerCallUsd({ rows: [{ model: 'm', group: 'g', kind: 'call' }] }, 'm', 'g')).toBeNull()
  })

  it('quotes the price times the calls, marks video an estimate and never reads a fraction of a cent as free', () => {
    expect(videoStudioQuoteText(0.8, 2, true)).toBe('预计约 $1.60（估算）')
    expect(videoStudioQuoteText(0.8, 1, false)).toBe('预计约 $0.80')
    expect(videoStudioQuoteText(617, 2, true)).toBe('预计约 $1,234.00（估算）')
    expect(videoStudioQuoteText(0.004, 1, false)).toBe('预计不到 $0.01')
    expect(videoStudioQuoteText(0, 3, false)).toBe('预计约 $0.00')
  })

  it('says nothing without a price or calls to price', () => {
    expect(videoStudioQuoteText(null, 2, true)).toBeNull()
    expect(videoStudioQuoteText(0.8, 0, true)).toBeNull()
    expect(videoStudioQuoteText(0.8, 1.5, true)).toBeNull()
  })

  it('reads once for every confirmation within the cache window and again once it is stale', async () => {
    let now = 1_000
    let reads = 0
    let changes = 0
    const cache = createVideoStudioPriceCache({ now: () => now, onChange: () => { changes += 1 } })
    const read = async () => { reads += 1; return list }
    cache.refresh('xm:7', read)
    cache.refresh('xm:7', read)
    expect(cache.current('xm:7')).toBeNull()
    await settle()
    expect(cache.current('xm:7')).toBe(list)
    expect([reads, changes]).toEqual([1, 1])
    now += videoStudioPriceListMaxAgeMs - 1
    cache.refresh('xm:7', read)
    expect(reads).toBe(1)
    now += 1
    cache.refresh('xm:7', read)
    await settle()
    expect(reads).toBe(2)
  })

  it('keeps the last list after a failed read and waits before asking again', async () => {
    let now = 1_000
    let fail = false
    let reads = 0
    const cache = createVideoStudioPriceCache({ now: () => now, onChange: () => undefined })
    const read = async () => { reads += 1; if (fail) throw new Error('账号刚刚切换，请重试'); return list }
    cache.refresh('xm:7', read)
    await settle()
    fail = true
    now += videoStudioPriceListMaxAgeMs
    cache.refresh('xm:7', read)
    await settle()
    expect(reads).toBe(2)
    expect(cache.current('xm:7')).toBe(list)
    now += videoStudioPriceListRetryMs - 1
    cache.refresh('xm:7', read)
    expect(reads).toBe(2)
    now += 1
    fail = false
    cache.refresh('xm:7', read)
    await settle()
    expect(reads).toBe(3)
  })

  it('never shows one account the list read for another', async () => {
    const cache = createVideoStudioPriceCache({ onChange: () => undefined })
    const first = deferred<AccountPriceList | null>()
    const other: AccountPriceList = { rows: [{ model: 'grok-imagine-video-1.5', group: '图片模型', kind: 'call', perCall: 3 }] }
    cache.refresh('xm:7', () => first.promise)
    // 换了账号：上一个账号那次读还没回来，回来了也不算这个账号的。
    cache.refresh('xm:8', async () => other)
    first.resolve(list)
    await settle()
    expect(cache.current('xm:8')).toBe(other)
    expect(cache.current('xm:7')).toBeNull()
  })

  it('drops the read in flight when the page goes away and starts over on the next refresh', async () => {
    let changes = 0
    const cache = createVideoStudioPriceCache({ onChange: () => { changes += 1 } })
    const first = deferred<AccountPriceList | null>()
    cache.refresh('xm:7', () => first.promise)
    cache.cancel()
    first.resolve(list)
    await settle()
    expect([cache.current('xm:7'), changes]).toEqual([null, 0])
    cache.refresh('xm:7', async () => list)
    await settle()
    expect([cache.current('xm:7'), changes]).toEqual([list, 1])
  })
})

import { describe, expect, it, vi } from 'vitest'
import {
  createVideoCoverCache,
  videoCoverMaxEdge,
  videoCoverSeekTime,
  videoCoverSize,
} from './video-cover'

describe('videoCoverSeekTime', () => {
  it('never grabs the opening frame, which is usually black or a fade-in', () => {
    expect(videoCoverSeekTime(4)).toBeCloseTo(0.4)
    expect(videoCoverSeekTime(4)).toBeGreaterThan(0)
  })

  it('caps the seek at one second so a long clip still shows something early', () => {
    expect(videoCoverSeekTime(60)).toBe(1)
    expect(videoCoverSeekTime(10)).toBe(1)
  })

  it('falls back to the first frame only when the duration is unusable', () => {
    // A stream whose duration is Infinity or missing has nowhere to seek to.
    expect(videoCoverSeekTime(Number.POSITIVE_INFINITY)).toBe(0)
    expect(videoCoverSeekTime(Number.NaN)).toBe(0)
    expect(videoCoverSeekTime(0)).toBe(0)
    expect(videoCoverSeekTime(-3)).toBe(0)
  })
})

describe('videoCoverSize', () => {
  it('contains the frame within the thumbnail edge and keeps its aspect', () => {
    expect(videoCoverSize(1920, 1080)).toEqual({ width: 320, height: 180 })
    expect(videoCoverSize(1080, 1920)).toEqual({ width: 180, height: 320 })
  })

  it('never enlarges a frame that is already small', () => {
    expect(videoCoverSize(120, 90)).toEqual({ width: 120, height: 90 })
  })

  it('falls back to a square when the element reports no dimensions yet', () => {
    expect(videoCoverSize(0, 0)).toEqual({ width: videoCoverMaxEdge, height: videoCoverMaxEdge })
  })
})

describe('createVideoCoverCache', () => {
  it('keeps at most one capture running, whatever the grid asks for', async () => {
    let live = 0
    let peak = 0
    const capture = vi.fn(async () => {
      live += 1
      peak = Math.max(peak, live)
      await Promise.resolve()
      live -= 1
      return 'data:image/jpeg;base64,AA'
    })
    const cache = createVideoCoverCache({ capture })

    await Promise.all(['a', 'b', 'c', 'd'].map((src) => cache.resolve(src)))

    expect(peak).toBe(1)
    expect(capture).toHaveBeenCalledTimes(4)
  })

  it('captures a source once however many tiles ask for it', async () => {
    const capture = vi.fn(async () => 'data:image/jpeg;base64,AA')
    const cache = createVideoCoverCache({ capture })

    const [first, second] = await Promise.all([cache.resolve('same'), cache.resolve('same')])

    expect(first).toBe(second)
    expect(capture).toHaveBeenCalledTimes(1)
  })

  it('remembers a file it could not decode instead of retrying it on every scroll', async () => {
    const capture = vi.fn(async () => { throw new Error('decode failed') })
    const cache = createVideoCoverCache({ capture })

    await expect(cache.resolve('broken')).resolves.toBeNull()
    await expect(cache.resolve('broken')).resolves.toBeNull()
    expect(capture).toHaveBeenCalledTimes(1)
  })

  it('keeps a failed capture from stalling the ones behind it', async () => {
    const capture = vi.fn(async (src: string) => {
      if (src === 'broken') throw new Error('decode failed')
      return `data:${src}`
    })
    const cache = createVideoCoverCache({ capture })

    const [broken, next] = await Promise.all([cache.resolve('broken'), cache.resolve('fine')])

    expect(broken).toBeNull()
    expect(next).toBe('data:fine')
  })

  it('bounds what it holds on to, since each entry is an inline image', async () => {
    const cache = createVideoCoverCache({ capture: async () => 'data:image/jpeg;base64,AA', maximumEntries: 2 })

    await cache.resolve('one')
    await cache.resolve('two')
    await cache.resolve('three')

    expect(cache.size()).toBe(2)
  })
})

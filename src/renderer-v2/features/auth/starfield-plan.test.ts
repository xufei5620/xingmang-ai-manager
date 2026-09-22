import { describe, expect, it } from 'vitest'
import { starfieldAnimates, starfieldFrameDue, starfieldFrameIntervalMs, starfieldLinks, starfieldPixelRatio } from './starfield-plan'

const calm = { paused: false, reducedMotion: false, systemReducedMotion: false, lowEndDevice: false }

describe('starfieldAnimates', () => {
  it('animates only when nothing asks for a still sky', () => {
    expect(starfieldAnimates(calm)).toBe(true)
    expect(starfieldAnimates({ ...calm, paused: true })).toBe(false)
    expect(starfieldAnimates({ ...calm, reducedMotion: true })).toBe(false)
    expect(starfieldAnimates({ ...calm, systemReducedMotion: true })).toBe(false)
    expect(starfieldAnimates({ ...calm, lowEndDevice: true })).toBe(false)
  })
})

describe('starfieldFrameDue', () => {
  it('paints the first frame immediately', () => {
    expect(starfieldFrameDue(0, null)).toBe(true)
  })

  it('skips every other frame of a 60Hz display', () => {
    let last: number | null = null
    let painted = 0
    for (let frame = 0; frame < 60; frame++) {
      // requestAnimationFrame timestamps jitter by a millisecond or two.
      const time = frame * (1000 / 60) + (frame % 2 === 0 ? 1.2 : -1.1)
      if (starfieldFrameDue(time, last)) { last = time; painted++ }
    }
    expect(painted).toBe(30)
  })

  it('keeps painting every frame of a 30Hz display', () => {
    let last: number | null = null
    let painted = 0
    for (let frame = 0; frame < 30; frame++) {
      const time = frame * starfieldFrameIntervalMs + (frame % 2 === 0 ? 1.5 : -1.5)
      if (starfieldFrameDue(time, last)) { last = time; painted++ }
    }
    expect(painted).toBe(30)
  })
})

describe('starfieldPixelRatio', () => {
  it('keeps the existing ratio for the default window size', () => {
    expect(starfieldPixelRatio(1, 1280, 820)).toBe(1)
    expect(starfieldPixelRatio(1.5, 1280, 820)).toBe(1.5)
    expect(starfieldPixelRatio(2, 1280, 820)).toBe(2)
    expect(starfieldPixelRatio(3, 1280, 820)).toBe(2)
  })

  it('caps the backing store when a large window sits on a high-density screen', () => {
    const ratio = starfieldPixelRatio(2, 1920, 1080)
    expect(ratio).toBeLessThan(2)
    expect(ratio).toBeGreaterThanOrEqual(1)
    expect(1920 * 1080 * ratio * ratio).toBeLessThanOrEqual(2880 * 1800 + 1)
  })

  it('never goes below one device pixel per CSS pixel', () => {
    expect(starfieldPixelRatio(2, 7680, 4320)).toBe(1)
    expect(starfieldPixelRatio(0, 1280, 820)).toBe(1)
    expect(starfieldPixelRatio(2, 0, 0)).toBe(2)
  })
})

describe('starfieldLinks', () => {
  it('joins stars closer than 90 pixels with a strength that fades with distance', () => {
    const stars = [
      { x: 0, y: 0, radius: 1, phase: 0, speed: 1, gold: false },
      { x: 0.045, y: 0, radius: 1, phase: 0, speed: 1, gold: false },
      { x: 0.5, y: 0.5, radius: 1, phase: 0, speed: 1, gold: true },
    ]
    const links = starfieldLinks(stars, 1000, 1000)
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({ ax: 0, ay: 0, bx: 45, by: 0 })
    expect(links[0].strength).toBeCloseTo(0.5)
  })

  it('recomputes against the current size', () => {
    const stars = [
      { x: 0, y: 0, radius: 1, phase: 0, speed: 1, gold: false },
      { x: 0.1, y: 0, radius: 1, phase: 0, speed: 1, gold: false },
    ]
    expect(starfieldLinks(stars, 800, 600)).toHaveLength(1)
    expect(starfieldLinks(stars, 1600, 600)).toHaveLength(0)
  })
})

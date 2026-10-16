import { describe, expect, it } from 'vitest'
import { buildWelcomeStarLinks, buildWelcomeStars, welcomeStarCount, welcomeStarGroup, welcomeStarGroupCount } from './welcome-starfield'

describe('renderer-v2 welcome starfield', () => {
  it('places the same 170 stars as the 0.2.18 canvas starfield', () => {
    const stars = buildWelcomeStars()
    expect(stars).toHaveLength(welcomeStarCount)
    expect(stars).toEqual(buildWelcomeStars())
    // 0.2.18 Starfield with seed 311: the first star sits at the bottom-left edge and is gold.
    expect(stars[0].x).toBeCloseTo(.002434, 6)
    expect(stars[0].y).toBeCloseTo(.908252, 6)
    expect(stars[0].radius).toBeCloseTo(1.591906, 6)
    expect(stars[0].gold).toBe(true)
    expect(stars.filter((star) => star.gold)).toHaveLength(34)
    for (const star of stars) {
      expect(star.x).toBeGreaterThanOrEqual(0)
      expect(star.x).toBeLessThan(1)
      expect(star.y).toBeGreaterThanOrEqual(0)
      expect(star.y).toBeLessThan(1)
      expect(star.radius).toBeGreaterThanOrEqual(.4)
      expect(star.radius).toBeLessThan(1.6)
    }
  })

  it('links only neighbours within 90px of the default window, brighter when closer', () => {
    const stars = buildWelcomeStars()
    const links = buildWelcomeStarLinks(stars)
    expect(links).toHaveLength(304)
    for (const link of links) {
      expect(Math.hypot((link.ax - link.bx) * 1280, (link.ay - link.by) * 820)).toBeLessThanOrEqual(90)
      expect(link.strength).toBeGreaterThanOrEqual(0)
      expect(link.strength).toBeLessThanOrEqual(1)
    }
    const near = buildWelcomeStarLinks([{ x: .5, y: .5, radius: 1, speed: 0, gold: false }, { x: .5 + 10 / 1280, y: .5, radius: 1, speed: 0, gold: false }])
    const far = buildWelcomeStarLinks([{ x: .5, y: .5, radius: 1, speed: 0, gold: false }, { x: .5 + 80 / 1280, y: .5, radius: 1, speed: 0, gold: false }])
    expect(near[0].strength).toBeGreaterThan(far[0].strength)
    expect(buildWelcomeStarLinks([{ x: 0, y: 0, radius: 1, speed: 0, gold: false }, { x: .5, y: .5, radius: 1, speed: 0, gold: false }])).toEqual([])
  })

  it('spreads the stars over every twinkle layer', () => {
    const counts = Array.from({ length: welcomeStarGroupCount }, () => 0)
    for (const star of buildWelcomeStars()) counts[welcomeStarGroup(star)]++
    expect(counts.every((count) => count > 0)).toBe(true)
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(welcomeStarCount)
    expect(welcomeStarGroup({ x: 0, y: 0, radius: 1, speed: 1, gold: false })).toBe(welcomeStarGroupCount - 1)
    expect(welcomeStarGroup({ x: 0, y: 0, radius: 1, speed: 0, gold: false })).toBe(0)
  })
})

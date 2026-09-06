import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Custom properties written by the renderer at runtime rather than declared in
// a stylesheet. They must keep a fallback so the rule below stays meaningful.
const runtimeAssignedProperties = new Set(['--wf-progress'])

const typeScale = new Set([
  'var(--text-xs)',
  'var(--text-sm)',
  'var(--text-base)',
  'var(--text-md)',
  'var(--text-lg)',
  'var(--text-xl)',
  'inherit',
])

const maximumRadiusPx = 8

function readSource(name: string): string {
  return fs.readFileSync(path.join(import.meta.dirname, '..', name), 'utf8')
}

function styleSheet(): string {
  return readSource('styles.css')
}

function themeSheet(): string {
  return readSource('theme.css')
    + fs.readFileSync(path.join(import.meta.dirname, '..', '..', '..', 'src', 'styles', 'ui-tokens.css'), 'utf8')
    + readSource('theme/brand-appearance.css')
}

function declaredProperties(...sources: string[]): Set<string> {
  const declared = new Set<string>()
  for (const source of sources) {
    for (const match of source.matchAll(/(--[a-z0-9-]+)\s*:/gi)) declared.add(match[1])
  }
  return declared
}

describe('canvas token discipline', () => {
  it('keeps literal colors out of the business stylesheet', () => {
    const offenders = styleSheet()
      .split(/\r?\n/)
      .flatMap((line, index) => {
        const matches = line.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)
        return matches ? [`${index + 1}: ${matches.join(', ')}`] : []
      })
    expect(offenders).toEqual([])
  })

  it('renders every font size from the six step scale', () => {
    const values = [...styleSheet().matchAll(/font-size:\s*([^;}]+)/g)].map((match) => match[1].trim())
    const offenders = values.filter((value) => !typeScale.has(value))
    expect(offenders).toEqual([])
  })

  it('never renders below the eleven pixel readability floor', () => {
    const floor = themeSheet().match(/--text-xs:\s*([0-9]+)px/)
    expect(floor).not.toBeNull()
    expect(Number(floor?.[1])).toBeGreaterThanOrEqual(11)
  })

  it('draws every spacing value from the scale', () => {
    const offenders = [...styleSheet().matchAll(
      /(?:^|[;{\s])(padding|margin|gap|row-gap|column-gap)(?:-[a-z-]+)?\s*:\s*([^;}]+)/g,
    )].flatMap((match) => {
      const value = match[2].trim()
      // Viewport-relative formulas and deliberate negative overlaps are not
      // rhythm and are exempt by design.
      if (/(calc|clamp|min|max)\(/.test(value)) return []
      return value.split(/\s+/).filter((token) => /^[0-9.]+px$/.test(token)).map((token) => `${match[1]}: ${value}`)
    })
    expect([...new Set(offenders)]).toEqual([])
  })

  it('keeps every corner radius within the eight pixel ceiling', () => {
    const offenders = [...styleSheet().matchAll(/border-radius:\s*([^;}]+)/g)]
      .flatMap((match) => match[1].trim().split(/\s+/))
      .filter((token) => {
        const pixels = token.match(/^([0-9.]+)px$/)
        return pixels !== null && Number(pixels[1]) > maximumRadiusPx
      })
    expect(offenders).toEqual([])
  })

  it('resolves every custom property the stylesheet references', () => {
    const declared = declaredProperties(styleSheet(), themeSheet())
    const referenced = [...styleSheet().matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map((match) => match[1])
    const unresolved = [...new Set(referenced)]
      .filter((property) => !declared.has(property) && !runtimeAssignedProperties.has(property))
    expect(unresolved).toEqual([])
  })

  it('gives runtime assigned properties a fallback so they never resolve to nothing', () => {
    const source = styleSheet()
    for (const property of runtimeAssignedProperties) {
      const references = [...source.matchAll(new RegExp(`var\\(\\s*${property}\\s*(,?)`, 'g'))]
      expect(references.length).toBeGreaterThan(0)
      for (const reference of references) expect(reference[1]).toBe(',')
    }
  })

  it('mirrors every standalone theme color in the light theme block', () => {
    const theme = themeSheet()
    const lightBlock = theme.slice(theme.indexOf(':root[data-theme="light"]'))
    expect(lightBlock).toContain('--state-queued:')
    expect(lightBlock).toContain('--state-cached:')
    expect(lightBlock).toContain('--shadow-menu:')
    expect(lightBlock).toContain('--shadow-panel:')
    expect(lightBlock).toContain('--shadow-modal:')
    expect(lightBlock).toContain('--shadow-lightbox:')
    expect(lightBlock).toContain('--canvas-edge:')
  })

  it('gives every port kind a hue', () => {
    const theme = themeSheet()
    const styles = styleSheet()
    // Mirrors PortKind in model.ts. Audio shipped without a rule, so audio
    // ports rendered unfilled and read as disabled.
    for (const kind of ['text', 'image', 'video', 'audio']) {
      expect(theme).toContain(`--port-${kind}:`)
      expect(styles).toContain(`.wf-port-${kind} {`)
    }
  })
})

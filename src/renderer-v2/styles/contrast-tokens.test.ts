import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Pure arithmetic over tokens.css: the renderer-v2 project runs without a DOM,
// and the ratios only depend on the declared values, never on layout.
const tokens = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8')
// The two v4 themes the high-contrast palettes have to cover completely.
const themeTokens = readFileSync(new URL('../../../ui-spec/tokens.css', import.meta.url), 'utf8')

type Rgb = [number, number, number]
interface Rgba {
  rgb: Rgb
  alpha: number
}

function block(selector: string, source = tokens) {
  const start = source.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`missing block ${selector}`)
  const body = source.slice(source.indexOf('{', start) + 1, source.indexOf('}', start))
  const values = new Map<string, string>()
  for (const declaration of body.split(';')) {
    const colon = declaration.indexOf(':')
    if (colon < 0) continue
    values.set(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim())
  }
  return values
}

function parseColor(value: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(value)
  if (hex) {
    const n = Number.parseInt(hex[1], 16)
    return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], alpha: 1 }
  }
  const rgba = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/.exec(value)
  if (rgba) {
    return {
      rgb: [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])],
      alpha: Number(rgba[4]),
    }
  }
  throw new Error(`unsupported color ${value}`)
}

function over(top: Rgba, base: Rgb): Rgb {
  return [0, 1, 2].map((i) => top.rgb[i] * top.alpha + base[i] * (1 - top.alpha)) as Rgb
}

function luminance(rgb: Rgb) {
  const [r, g, b] = rgb.map((channel) => {
    const c = channel / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function ratio(a: Rgb, b: Rgb) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light + 0.05) / (dark + 0.05)
}

function palette(values: Map<string, string>) {
  function solid(name: string): Rgb {
    const value = values.get(name)
    if (!value) throw new Error(`missing ${name}`)
    const color = parseColor(value)
    if (color.alpha !== 1) throw new Error(`${name} must be opaque in high contrast`)
    return color.rgb
  }
  function layered(name: string, base: string): Rgb {
    const value = values.get(name)
    if (!value) throw new Error(`missing ${name}`)
    return over(parseColor(value), solid(base))
  }
  return { solid, layered }
}

const surfaces = ['--win', '--rail', '--bg', '--panel-solid', '--panel-2', '--panel-hover', '--btn-2-bg', '--btn-2-hover', '--kbd-bg', '--input', '--pop']

// What a default theme really paints: the prototype's palette in
// ui-spec/tokens.css, then the few control edges tokens.css deepens over it (D82).
function defaultTheme(theme: string) {
  return new Map([...block(`[data-theme="${theme}"]`, themeTokens), ...block(`[data-theme="${theme}"]`)])
}

// Default themes paint with translucent layers and gradients, so a token can
// stand for several colors: one per gradient stop, composited over whatever
// opaque surface sits beneath it.
function stops(value: string): Rgba[] {
  if (!value.startsWith('linear-gradient(')) return [parseColor(value)]
  const colors = value.match(/#[0-9a-f]{6}|rgba\([^)]*\)/gi)
  if (!colors) throw new Error(`gradient without colors ${value}`)
  return colors.map(parseColor)
}

function weakest(pairs: Array<[string, Rgb, Rgb]>) {
  return Math.min(...pairs.map(([, fg, bg]) => ratio(fg, bg)))
}

describe.each(['dark', 'light'])('high contrast tokens (%s)', (theme) => {
  const values = block(`:root[data-theme="${theme}"].hc`)
  const { solid, layered } = palette(values)

  function failures(pairs: Array<[string, Rgb, Rgb]>, minimum: number) {
    return pairs
      .map(([label, fg, bg]) => [label, Math.round(ratio(fg, bg) * 100) / 100] as const)
      .filter(([, value]) => value < minimum)
  }

  it('overrides every token the theme sets, so no tinted or translucent theme color leaks through', () => {
    const missing = [...defaultTheme(theme).keys()].filter((name) => !values.has(name))
    expect(missing).toEqual([])
  })

  it('keeps all three text levels at 4.5:1 on every surface', () => {
    const pairs: Array<[string, Rgb, Rgb]> = []
    for (const text of ['--text', '--text-2', '--text-3']) {
      for (const surface of surfaces) pairs.push([`${text} on ${surface}`, solid(text), solid(surface)])
    }
    expect(failures(pairs, 4.5)).toEqual([])
  })

  it('keeps accent text, primary buttons and selected rows at 4.5:1', () => {
    const pairs: Array<[string, Rgb, Rgb]> = [
      ['accent-fg on accent', solid('--accent-fg'), solid('--accent')],
      ['accent-fg on accent-2', solid('--accent-fg'), solid('--accent-2')],
    ]
    pairs.push(['pri-tx on pri', solid('--pri-tx'), solid('--pri')])
    pairs.push(['toast-tx on toast', solid('--toast-tx'), solid('--toast')])
    for (const surface of ['--rail', '--bg', '--panel-solid', '--pop']) {
      pairs.push([`accent on ${surface}`, solid('--accent'), solid(surface)])
      pairs.push([`gold-tx on ${surface}`, solid('--gold-tx'), solid(surface)])
      pairs.push([`num on ${surface}`, solid('--num'), solid(surface)])
      pairs.push([`accent on accent-soft over ${surface}`, solid('--accent'), layered('--accent-soft', surface)])
      pairs.push([`text on accent-soft over ${surface}`, solid('--text'), layered('--accent-soft', surface)])
      pairs.push([`soft-tx on soft over ${surface}`, solid('--soft-tx'), layered('--soft', surface)])
      pairs.push([`info-tx on info-bg over ${surface}`, solid('--info-tx'), layered('--info-bg', surface)])
    }
    expect(failures(pairs, 4.5)).toEqual([])
  })

  it('keeps status colors readable on plain and tinted surfaces', () => {
    const pairs: Array<[string, Rgb, Rgb]> = []
    for (const tone of ['ok', 'warn', 'bad']) {
      for (const surface of ['--bg', '--panel-solid', '--panel-2', '--pop']) {
        for (const text of [`--${tone}`, `--${tone}-tx`]) {
          pairs.push([`${text} on ${surface}`, solid(text), solid(surface)])
          pairs.push([`${text} on ${tone}-soft over ${surface}`, solid(text), layered(`--${tone}-soft`, surface)])
        }
      }
    }
    expect(failures(pairs, 4.5)).toEqual([])
  })

  it('draws borders, dividers and the focus ring at 3:1 against their surfaces', () => {
    const pairs: Array<[string, Rgb, Rgb]> = []
    for (const line of ['--line', '--line-2', '--line-3', '--info', '--focus', '--input-line', '--pop-line', '--gold', '--sw-on']) {
      for (const surface of ['--win', '--rail', '--bg', '--panel-solid', '--panel-2']) {
        pairs.push([`${line} on ${surface}`, solid(line), solid(surface)])
      }
    }
    pairs.push(['switch thumb on track', solid('--text-2'), solid('--panel-2')])
    for (const icon of ['--toast-ok', '--toast-info', '--toast-warn']) pairs.push([`${icon} on toast`, solid(icon), solid('--toast')])
    expect(failures(pairs, 3)).toEqual([])
  })
})

describe.each(['dark', 'light'])('default theme tokens (%s)', (theme) => {
  const values = defaultTheme(theme)

  function colors(name: string) {
    const value = values.get(name)
    if (!value) throw new Error(`missing ${name}`)
    return stops(value)
  }
  function solid(name: string): Rgb {
    const [color, ...rest] = colors(name)
    if (rest.length || color.alpha !== 1) throw new Error(`${name} is not one opaque color`)
    return color.rgb
  }
  // Every color a translucent or gradient token turns into over an opaque base.
  function composite(name: string, base: Rgb): Rgb[] {
    return colors(name).map((color) => over(color, base))
  }

  // The opaque grounds every page, card, sidebar and dialog starts from, plus
  // the translucent card and section layers drawn on the page.
  const bases = ['--win', '--rail', '--bg', '--panel-solid', '--pop'].map((name): [string, Rgb] => [name, solid(name)])
  const grounds: Array<[string, Rgb]> = [...bases]
  for (const [layer, base] of [['--panel', '--bg'], ['--panel-2', '--bg'], ['--panel-2', '--panel-solid']]) {
    for (const color of composite(layer, solid(base))) grounds.push([`${layer} over ${base}`, color])
  }

  function failures(pairs: Array<[string, Rgb, Rgb]>, minimum: number) {
    return pairs
      .map(([label, fg, bg]) => [label, Math.round(ratio(fg, bg) * 100) / 100] as const)
      .filter(([, value]) => value < minimum)
  }

  // Guards against a later palette change quietly fading text: the prototype's
  // colors pass today, and these pairs keep it that way. The third level (hints,
  // placeholders, key caps) is held on the plain grounds and inside fields only:
  // stacked on a hover tint, a button fill or a key cap over a section layer it
  // already dips to between 3.4 and 4.5 in the prototype's palette, and raising
  // it is a palette change of its own, not part of D82.
  it('keeps all three text levels at 4.5:1 on the grounds and inside fields', () => {
    const pairs: Array<[string, Rgb, Rgb]> = []
    for (const text of ['--text', '--text-2', '--text-3']) {
      for (const [ground, base] of grounds) {
        pairs.push([`${text} on ${ground}`, solid(text), base])
        for (const color of composite('--input', base)) pairs.push([`${text} on --input over ${ground}`, solid(text), color])
      }
    }
    expect(failures(pairs, 4.5)).toEqual([])
  })

  it('keeps body and secondary text at 4.5:1 on hover tints, button fills and key caps', () => {
    const pairs: Array<[string, Rgb, Rgb]> = []
    for (const text of ['--text', '--text-2']) {
      for (const [ground, base] of grounds) {
        for (const layer of ['--panel-hover', '--btn-2-bg', '--btn-2-hover', '--kbd-bg']) {
          for (const color of composite(layer, base)) pairs.push([`${text} on ${layer} over ${ground}`, solid(text), color])
        }
      }
    }
    expect(failures(pairs, 4.5)).toEqual([])
  })

  it('keeps button text, accent text and status text at 4.5:1', () => {
    const pairs: Array<[string, Rgb, Rgb]> = []
    for (const color of colors('--pri')) pairs.push(['pri-tx on pri', solid('--pri-tx'), color.rgb])
    pairs.push(['accent-fg on accent', solid('--accent-fg'), solid('--accent')])
    pairs.push(['toast-tx on toast', solid('--toast-tx'), solid('--toast')])
    for (const [ground, base] of bases) {
      for (const text of ['--accent', '--gold-tx', '--num', '--info-tx', '--ok-tx', '--warn-tx', '--bad-tx']) pairs.push([`${text} on ${ground}`, solid(text), base])
      for (const color of composite('--accent-soft', base)) pairs.push([`text on accent-soft over ${ground}`, solid('--text'), color])
      for (const color of composite('--soft', base)) pairs.push([`soft-tx on soft over ${ground}`, solid('--soft-tx'), color])
      for (const color of composite('--info-bg', base)) pairs.push([`info-tx on info-bg over ${ground}`, solid('--info-tx'), color])
      for (const tone of ['ok', 'warn', 'bad']) {
        for (const color of composite(`--${tone}-soft`, base)) pairs.push([`${tone}-tx on ${tone}-soft over ${ground}`, solid(`--${tone}-tx`), color])
      }
    }
    expect(failures(pairs, 4.5)).toEqual([])
  })

  it('draws the focus ring and the switch-on track at 3:1 against their surfaces', () => {
    const pairs: Array<[string, Rgb, Rgb]> = []
    for (const line of ['--focus', '--sw-on']) {
      for (const [ground, base] of grounds) pairs.push([`${line} on ${ground}`, solid(line), base])
    }
    expect(failures(pairs, 3)).toEqual([])
  })

  // D82: an empty field's edge is all that shows where it is (in light, a white
  // field on a white card), and a secondary button's edge is what shows how far
  // it reaches. The edge is painted over the control's own fill, so it is held
  // to 3:1 against both the ground outside and the fill inside; a fill-less
  // ring (the chat compose box) is the same edge over the ground alone.
  // Hovering must never make it fainter.
  describe.each([
    ['inputs', '--input-line', '--input-line-hover', '--input'],
    ['secondary buttons', '--btn-2-line', '--btn-2-line-hover', '--btn-2-bg'],
  ])('%s', (_, rest, hover, fill) => {
    function edges(line: string) {
      const pairs: Array<[string, Rgb, Rgb]> = []
      for (const [ground, outside] of grounds) {
        for (const inside of [outside, ...composite(fill, outside)]) {
          for (const edge of composite(line, inside)) {
            pairs.push([`${line} against ${ground}`, edge, outside])
            pairs.push([`${line} against its fill over ${ground}`, edge, inside])
          }
        }
      }
      return pairs
    }

    it('draws the edge at 3:1 against the ground and the fill', () => {
      expect(failures(edges(rest), 3)).toEqual([])
    })

    it('makes the edge stronger on hover, never fainter', () => {
      expect(weakest(edges(hover))).toBeGreaterThan(weakest(edges(rest)))
    })
  })
})

describe('high contrast stylesheet order', () => {
  it('loads contrast.css after every other stylesheet in the app entry', () => {
    // The eagerly loaded stylesheets share selectors with it at equal weight;
    // only the order decides between them.
    const entry = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8')
    const sheets = [...entry.matchAll(/^import '([^']+\.css)'$/gm)].map((match) => match[1])
    expect(sheets.at(-1)).toBe('./styles/contrast.css')
  })
})

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

describe.each(['dark', 'light'])('high contrast tokens (%s)', (theme) => {
  const values = block(`:root[data-theme="${theme}"].hc`)
  const { solid, layered } = palette(values)

  function failures(pairs: Array<[string, Rgb, Rgb]>, minimum: number) {
    return pairs
      .map(([label, fg, bg]) => [label, Math.round(ratio(fg, bg) * 100) / 100] as const)
      .filter(([, value]) => value < minimum)
  }

  it('overrides every token the theme sets, so no tinted or translucent theme color leaks through', () => {
    const themeValues = block(`[data-theme="${theme}"]`, themeTokens)
    const missing = [...themeValues.keys()].filter((name) => !values.has(name))
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

describe('high contrast stylesheet order', () => {
  it('loads contrast.css after every other stylesheet in the app entry', () => {
    // The eagerly loaded stylesheets share selectors with it at equal weight;
    // only the order decides between them.
    const entry = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8')
    const sheets = [...entry.matchAll(/^import '([^']+\.css)'$/gm)].map((match) => match[1])
    expect(sheets.at(-1)).toBe('./styles/contrast.css')
  })
})

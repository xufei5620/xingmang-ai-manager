import { describe, expect, it } from 'vitest'
import { createLayerColorCalibrationTransform } from './layer-color-calibration-raster'
import { defaultImageLayerColorCalibration, imageLayerColorCalibrationAmounts, type ImageLayerColorCalibration } from './layer-color-calibration'

const weights = [.2126, .7152, .0722]

function dot(a: readonly number[], b: readonly number[]): number { return a.reduce((sum, value, index) => sum + value * b[index], 0) }

/** Separate two-dimensional coordinates and matrix multiplication, rather than
 * the implementation's Rodrigues vector rotation and per-primary accumulation. */
function oracle(rgb: [number, number, number], controls: ImageLayerColorCalibration): number[] {
  if (!controls.enabled) return rgb
  const length = Math.hypot(weights[0], weights[1]), u = [weights[1] / length, -weights[0] / length, 0]
  const nLength = Math.hypot(...weights), n = weights.map((value) => value / nLength)
  const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]]
  const matrix = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
  for (const [index, primary] of (['red', 'green', 'blue'] as const).entries()) {
    const basis = [0, 1, 2].map((channel) => Number(channel === index) - weights[index]), a = dot(basis, u), b = dot(basis, v)
    const angle = controls[`${primary}Hue`] * Math.PI / 600, gain = 1 + controls[`${primary}Saturation`] * .005
    const nextU = gain * (a * Math.cos(angle) - b * Math.sin(angle)), nextV = gain * (a * Math.sin(angle) + b * Math.cos(angle))
    const delta = u.map((value, channel) => value * nextU + v[channel] * nextV - basis[channel])
    for (let row = 0; row < 3; row++) for (let column = 0; column < 3; column++) matrix[row][column] += delta[row] * (Number(column === index) - weights[column])
  }
  const y = dot(rgb, weights), t = Math.min(1, Math.max(0, (y - .02) / .48)), shadow = controls.shadowTint * .004 * y * (1 - t * t * (3 - 2 * t))
  const output = matrix.map((row, channel) => dot(row, rgb) + (channel === 1 ? -.2848 / .7152 : 1) * shadow)
  let gain = 1
  for (const value of output) {
    if (value < 0) gain = Math.min(gain, y / (y - value))
    else if (value > 1) gain = Math.min(gain, (1 - y) / (value - y))
  }
  return output.map((value) => Math.min(1, Math.max(0, y * (1 - gain) + value * gain)))
}

function luma(rgb: readonly number[]): number { return dot(rgb, weights) }

describe('linear primary calibration raster transform', () => {
  const samples: Array<[number, number, number]> = [[0, 0, 0], [1, 1, 1], [.5, .5, .5], [.25, .05, .08], [.03, .21, .04], [.08, .02, .28], [.25, .16, .08], [.04, .16, .18], [.8, .14, .23], [0, 1, .02], [.01, .03, .04]]

  it('preserves exact linear inputs for neutral and disabled configurations and freezes its parsed settings', () => {
    const neutral = defaultImageLayerColorCalibration(), disabled = { ...neutral, enabled: false, redHue: 100, blueSaturation: -100, shadowTint: 70 }
    for (const controls of [neutral, disabled]) for (const sample of samples) expect(createLayerColorCalibrationTransform(controls)(...sample)).toEqual(sample)
    const controls = { ...neutral, redHue: 60 }, transform = createLayerColorCalibrationTransform(controls), before = transform(.25, .05, .08)
    controls.redHue = -100
    expect(transform(.25, .05, .08)).toEqual(before)
  })

  it.each(imageLayerColorCalibrationAmounts)('matches an independent linear algebra oracle and implements both directions of %s', (key) => {
    const input: [number, number, number] = [.19, .08, .045], outputs: number[][] = []
    for (const amount of [-60, 60]) {
      const controls = { ...defaultImageLayerColorCalibration(), [key]: amount }, transform = createLayerColorCalibrationTransform(controls)
      for (const sample of samples) {
        const expected = oracle(sample, controls), actual = transform(...sample)
        for (let channel = 0; channel < 3; channel++) expect(actual[channel]).toBeCloseTo(expected[channel], 12)
        expect(luma(actual)).toBeCloseTo(luma(sample), 12)
      }
      const output = transform(...input)
      expect(Math.max(...output.map((value, index) => Math.abs(value - input[index])))).toBeGreaterThan(.0001)
      outputs.push(output)
    }
    expect(outputs[0]).not.toEqual(outputs[1])
  })

  it('preserves all neutral grays under all extreme primary settings and never changes black or white under shadow tint', () => {
    for (const amount of [-100, 100]) {
      const primary = { ...defaultImageLayerColorCalibration(), redHue: amount, redSaturation: amount, greenHue: -amount, greenSaturation: -amount, blueHue: amount, blueSaturation: -amount }
      for (let byte = 0; byte <= 255; byte++) {
        const value = byte / 255, rgb = createLayerColorCalibrationTransform(primary)(value, value, value)
        for (const actual of rgb) expect(actual).toBeCloseTo(value, 14)
      }
      for (const value of [0, 1]) expect(createLayerColorCalibrationTransform({ ...primary, shadowTint: amount })(value, value, value)).toEqual([value, value, value])
    }
  })

  it('adjusts shadow green versus magenta without repurposing the existing global tint or split-tone controls', () => {
    const positive = createLayerColorCalibrationTransform({ ...defaultImageLayerColorCalibration(), shadowTint: 100 }), negative = createLayerColorCalibrationTransform({ ...defaultImageLayerColorCalibration(), shadowTint: -100 })
    const low = positive(.04, .04, .04), high = positive(.7, .7, .7), opposite = negative(.04, .04, .04)
    expect(low[0]).toBeGreaterThan(low[1]); expect(low[2]).toBeGreaterThan(low[1])
    expect(opposite[1]).toBeGreaterThan(opposite[0]); expect(opposite[1]).toBeGreaterThan(opposite[2])
    expect(high).toEqual([.7, .7, .7])
    expect(luma(low)).toBeCloseTo(.04, 14); expect(luma(opposite)).toBeCloseTo(.04, 14)
  })

  it('recalibrates mixed colors outside the red HSL family and applies saturation as chroma rather than exposure', () => {
    const transform = createLayerColorCalibrationTransform({ ...defaultImageLayerColorCalibration(), redHue: 80 }), cyan: [number, number, number] = [.06, .25, .25]
    expect(transform(...cyan)).not.toEqual(cyan)
    const lower = createLayerColorCalibrationTransform({ ...defaultImageLayerColorCalibration(), redSaturation: -100 }), upper = createLayerColorCalibrationTransform({ ...defaultImageLayerColorCalibration(), redSaturation: 100 }), red: [number, number, number] = [.25, .08, .08]
    function spread(rgb: readonly number[]) { return Math.max(...rgb) - Math.min(...rgb) }
    expect(spread(lower(...red))).toBeLessThan(spread(red)); expect(spread(upper(...red))).toBeGreaterThan(spread(red))
    expect(luma(lower(...red))).toBeCloseTo(luma(red), 14); expect(luma(upper(...red))).toBeCloseTo(luma(red), 14)
  })

  it('keeps all endpoint combinations finite in gamut and luminance-preserving without an invertible-matrix assumption', () => {
    for (let combination = 0; combination < 128; combination++) {
      const controls = defaultImageLayerColorCalibration()
      for (const [index, key] of imageLayerColorCalibrationAmounts.entries()) controls[key] = combination & 1 << index ? 100 : -100
      const transform = createLayerColorCalibrationTransform(controls)
      for (const sample of samples) {
        const actual = transform(...sample), expected = oracle(sample, controls)
        for (let channel = 0; channel < 3; channel++) {
          expect(Number.isFinite(actual[channel])).toBe(true); expect(actual[channel]).toBeGreaterThanOrEqual(0); expect(actual[channel]).toBeLessThanOrEqual(1)
          expect(actual[channel]).toBeCloseTo(expected[channel], 12)
        }
        expect(luma(actual)).toBeCloseTo(luma(sample), 12)
      }
    }
  })
})

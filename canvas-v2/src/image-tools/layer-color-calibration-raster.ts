import { isNeutralImageLayerColorCalibration, parseImageLayerColorCalibration, type ImageLayerColorCalibration } from './layer-color-calibration'

const luminance = [.2126, .7152, .0722] as const

function smooth(low: number, high: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - low) / (high - low)))
  return t * t * (3 - 2 * t)
}

/** Independent working-space calibration, not an Adobe process emulation.
 * Each linear RGB primary owns a chromatic basis vector perpendicular to the
 * luminance axis. Hue rotates that vector, saturation scales it. Mixing their
 * deltas with the input's chromatic components creates a true cross-channel
 * basis transform: mixed colours respond too, without selecting an HSL band.
 * The neutral axis and linear luminance stay fixed until explicit shadow tint.
 * No spatial samples or frame-size auxiliary storage are needed. */
export function createLayerColorCalibrationTransform(value: ImageLayerColorCalibration): (r: number, g: number, b: number) => [number, number, number] {
  const calibration = parseImageLayerColorCalibration(value)
  if (isNeutralImageLayerColorCalibration(calibration)) return function neutral(r, g, b) { return [r, g, b] }
  const norm = Math.hypot(...luminance), axis = luminance.map((value) => value / norm)
  const columns: number[][] = []
  for (const [index, name] of (['red', 'green', 'blue'] as const).entries()) {
    const angle = calibration[`${name}Hue`] / 100 * Math.PI / 6, scale = 1 + calibration[`${name}Saturation`] / 200
    const basis = luminance.map((_, channel) => (channel === index ? 1 : 0) - luminance[index])
    const cross = [axis[1] * basis[2] - axis[2] * basis[1], axis[2] * basis[0] - axis[0] * basis[2], axis[0] * basis[1] - axis[1] * basis[0]]
    columns.push(basis.map((component, channel) => scale * (component * Math.cos(angle) + cross[channel] * Math.sin(angle)) - component))
  }
  const matrix = [0, 1, 2].map((row) => {
    const sum = columns[0][row] + columns[1][row] + columns[2][row]
    return [0, 1, 2].map((column) => Number(row === column) + columns[column][row] - sum * luminance[column])
  })
  const tint = calibration.shadowTint / 100 * .4, magentaGreen = -(luminance[0] + luminance[2]) / luminance[1]
  return function transform(r, g, b) {
    const y = r * luminance[0] + g * luminance[1] + b * luminance[2]
    const shade = tint * y * (1 - smooth(.02, .5, y))
    if (r === g && g === b && shade === 0) return [r, g, b]
    const red = matrix[0][0] * r + matrix[0][1] * g + matrix[0][2] * b + shade
    const green = matrix[1][0] * r + matrix[1][1] * g + matrix[1][2] * b + magentaGreen * shade
    const blue = matrix[2][0] * r + matrix[2][1] * g + matrix[2][2] * b + shade
    // Compress only out-of-gamut chroma around the unchanged luminance. Simple
    // channel clipping would introduce brightness/neutral-axis discontinuities.
    let compression = 1
    for (const component of [red, green, blue]) {
      const delta = component - y
      if (component > 1) compression = Math.min(compression, (1 - y) / delta)
      else if (component < 0) compression = Math.min(compression, -y / delta)
    }
    return [Math.max(0, Math.min(1, y + (red - y) * compression)), Math.max(0, Math.min(1, y + (green - y) * compression)), Math.max(0, Math.min(1, y + (blue - y) * compression))]
  }
}

export type ColorLutDomain = [number, number, number]
export interface ColorLutTable {
  version: 1
  size: 33
  domainMin: ColorLutDomain
  domainMax: ColorLutDomain
  data: Float32Array
  name: string
}
export interface ColorLutWorkOptions { signal?: AbortSignal; deadline?: number }
export interface ColorLutTableMetadata { name: string; domainMin: ColorLutDomain; domainMax: ColorLutDomain }
export interface ColorLutSamplingSettings { enabled: boolean; strength: number }

export const canonicalColorLutSize = 33
export const canonicalColorLutSampleCount = canonicalColorLutSize ** 3 * 3
export const canonicalColorLutByteLength = canonicalColorLutSampleCount * 4
export const maximumColorLutCubeBytes = 24 * 1024 * 1024
export const maximumColorLutNameLength = 160
export const colorLutValueLimit = 16

const numericToken = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/

function fail(message: string): never { throw new Error(`LUT ${message}；当前调整未改变`) }
function check(options: ColorLutWorkOptions): void {
  if (options.signal?.aborted) throw new DOMException('已取消 LUT 处理，当前调整保留', 'AbortError')
  if (options.deadline !== undefined && (!Number.isFinite(options.deadline) || Date.now() >= options.deadline)) fail('处理超时，请重新选择文件')
}
function boundedValue(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > colorLutValueLimit) fail('数值必须是 −16–16 范围内的有限数')
  return value
}
function tokenValue(value: string): number {
  if (!numericToken.test(value)) fail('包含无效的数值')
  return boundedValue(Number(value))
}
function hasLoneSurrogate(value: string): boolean { return /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(value) }
function nameValue(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximumColorLutNameLength || /[\u0000-\u001f\u007f]/.test(value) || hasLoneSurrogate(value)) fail('名称需要 1–160 个有效字符且不能含控制字符')
  return value.trim()
}
function domainValue(value: unknown): ColorLutDomain {
  if (!Array.isArray(value) || value.length !== 3) fail('输入域需要三个通道数值')
  return [boundedValue(value[0]), boundedValue(value[1]), boundedValue(value[2])]
}
function metadataValue(value: ColorLutTableMetadata): ColorLutTableMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !['name', 'domainMin', 'domainMax'].includes(key))) fail('表格元数据格式不正确')
  const name = nameValue(value.name), domainMin = domainValue(value.domainMin), domainMax = domainValue(value.domainMax)
  if (domainMin.some((minimum, channel) => minimum >= domainMax[channel])) fail('每个通道的输入域下限必须小于上限')
  return { name, domainMin, domainMax }
}
function tableValue(value: ColorLutTable, options: ColorLutWorkOptions): ColorLutTable {
  check(options)
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !['version', 'size', 'domainMin', 'domainMax', 'data', 'name'].includes(key)) || value.version !== 1 || value.size !== canonicalColorLutSize || !(value.data instanceof Float32Array) || value.data.length !== canonicalColorLutSampleCount) fail('需要版本 1 的完整 33³ Float32 表格')
  const metadata = metadataValue({ name: value.name, domainMin: value.domainMin, domainMax: value.domainMax }), data = new Float32Array(canonicalColorLutSampleCount)
  for (let index = 0; index < data.length; index++) {
    if (index % 3072 === 0) check(options)
    data[index] = boundedValue(value.data[index])
  }
  check(options)
  return { version: 1, size: canonicalColorLutSize, ...metadata, data }
}

/** IRIDAS Cube headers precede data. A combined shaper/3D file is a different
 * format and must fail instead of silently discarding either table. */
function withoutComment(line: string): string {
  let quoted = false, escaped = false
  for (let index = 0; index < line.length; index++) {
    const character = line[index]
    if (escaped) { escaped = false; continue }
    if (quoted && character === '\\') { escaped = true; continue }
    if (character === '"') quoted = !quoted
    else if (character === '#' && !quoted) return line.slice(0, index).trim()
  }
  return line.trim()
}
function* cubeLines(text: string): Generator<string> {
  const endings = /\r\n|\r|\n/g
  let from = 0, match: RegExpExecArray | null
  while ((match = endings.exec(text))) { yield text.slice(from, match.index); from = endings.lastIndex }
  yield text.slice(from)
}
function titleValue(value: string): string {
  if (!/^"(?:[^"\\\u0000-\u001f]|\\["\\])*"$/.test(value)) fail('TITLE 需要完整的双引号名称')
  let title: unknown
  try { title = JSON.parse(value) } catch { fail('TITLE 名称格式不正确') }
  return nameValue(title)
}
function mix(a: number, b: number, weight: number): number { return a + (b - a) * weight }
function sample3d(data: Float32Array, size: number, r: number, g: number, b: number): ColorLutDomain {
  const red = r * (size - 1), green = g * (size - 1), blue = b * (size - 1)
  const r0 = Math.floor(red), g0 = Math.floor(green), b0 = Math.floor(blue), r1 = Math.min(size - 1, r0 + 1), g1 = Math.min(size - 1, g0 + 1), b1 = Math.min(size - 1, b0 + 1)
  const rw = red - r0, gw = green - g0, bw = blue - b0
  const result: ColorLutDomain = [0, 0, 0]
  for (let channel = 0; channel < 3; channel++) {
    const nearLow = mix(data[((b0 * size + g0) * size + r0) * 3 + channel], data[((b0 * size + g0) * size + r1) * 3 + channel], rw)
    const nearHigh = mix(data[((b0 * size + g1) * size + r0) * 3 + channel], data[((b0 * size + g1) * size + r1) * 3 + channel], rw)
    const farLow = mix(data[((b1 * size + g0) * size + r0) * 3 + channel], data[((b1 * size + g0) * size + r1) * 3 + channel], rw)
    const farHigh = mix(data[((b1 * size + g1) * size + r0) * 3 + channel], data[((b1 * size + g1) * size + r1) * 3 + channel], rw)
    result[channel] = mix(mix(nearLow, nearHigh, gw), mix(farLow, farHigh, gw), bw)
  }
  return result
}
function sample1d(data: Float32Array, size: number, r: number, g: number, b: number): ColorLutDomain {
  const result: ColorLutDomain = [0, 0, 0], input = [r, g, b]
  for (let channel = 0; channel < 3; channel++) {
    const position = input[channel] * (size - 1), low = Math.floor(position), high = Math.min(size - 1, low + 1)
    result[channel] = mix(data[low * 3 + channel], data[high * 3 + channel], position - low)
  }
  return result
}
function canonicalTable(data: Float32Array, size: number, kind: '1d' | '3d', metadata: ColorLutTableMetadata, options: ColorLutWorkOptions): ColorLutTable {
  const result = new Float32Array(canonicalColorLutSampleCount)
  for (let blue = 0; blue < canonicalColorLutSize; blue++) for (let green = 0; green < canonicalColorLutSize; green++) {
    check(options)
    for (let red = 0; red < canonicalColorLutSize; red++) {
      const sample = kind === '1d' ? sample1d(data, size, red / 32, green / 32, blue / 32) : sample3d(data, size, red / 32, green / 32, blue / 32)
      result.set(sample, ((blue * canonicalColorLutSize + green) * canonicalColorLutSize + red) * 3)
    }
  }
  check(options)
  return { version: 1, size: canonicalColorLutSize, ...metadata, data: result }
}

/** Original TypeScript implementation of the IRIDAS 1D-or-3D Cube layout.
 * Safety policy is intentionally bounded to finite domains/samples in [-16,16]. */
export function parseColorLutCube(text: string, options: ColorLutWorkOptions = {}): ColorLutTable {
  check(options)
  if (typeof text !== 'string' || text.length > maximumColorLutCubeBytes || new TextEncoder().encode(text).byteLength > maximumColorLutCubeBytes) fail('Cube 文件不能超过 24 MiB')
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) || hasLoneSurrogate(text)) fail('Cube 包含无效的文本字符')
  let name = '未命名 LUT', domainMin: ColorLutDomain = [0, 0, 0], domainMax: ColorLutDomain = [1, 1, 1], kind: '1d' | '3d' | undefined, size = 0, rows = 0, lineNumber = 0
  let data: Float32Array | undefined
  const directives = new Set<string>()
  for (const original of cubeLines(text.replace(/^\uFEFF/, ''))) {
    if (++lineNumber % 128 === 1) check(options)
    if (original.length > 4096) fail('Cube 单行不能超过 4096 个字符')
    const line = withoutComment(original)
    if (!line) continue
    const first = line.match(/^\S+/)![0], body = line.slice(first.length).trim()
    if (numericToken.test(first)) {
      if (!data || !kind) fail('样本前必须声明 LUT_1D_SIZE 或 LUT_3D_SIZE')
      const values = line.split(/\s+/)
      if (values.length !== 3) fail('每行样本必须恰好包含 RGB 三个数值')
      if (rows >= data.length / 3) fail('样本数量多于声明的表格尺寸')
      data.set(values.map(tokenValue), rows++ * 3)
      continue
    }
    if (!['TITLE', 'DOMAIN_MIN', 'DOMAIN_MAX', 'LUT_1D_SIZE', 'LUT_3D_SIZE'].includes(first)) fail(`包含不支持的指令「${first.slice(0, 80)}」`)
    if (rows) fail('表格样本开始后不能再声明指令')
    if (directives.has(first)) fail(`指令 ${first} 重复，无法确定应采用哪个值`)
    directives.add(first)
    if (first === 'TITLE') name = titleValue(body)
    else if (first === 'DOMAIN_MIN' || first === 'DOMAIN_MAX') {
      const values = body.split(/\s+/)
      if (values.length !== 3) fail('输入域需要三个通道数值')
      const domain: ColorLutDomain = [tokenValue(values[0]), tokenValue(values[1]), tokenValue(values[2])]
      if (first === 'DOMAIN_MIN') domainMin = domain
      else domainMax = domain
    } else {
      if (kind) fail('不支持组合 1D shaper 与 3D 表格，请选择单独的 1D 或 3D Cube')
      if (!/^\d+$/.test(body)) fail('表格尺寸必须是整数')
      kind = first === 'LUT_1D_SIZE' ? '1d' : '3d'; size = Number(body)
      if (!Number.isSafeInteger(size) || size < 2 || size > (kind === '1d' ? 65536 : 65)) fail(kind === '1d' ? '1D 尺寸必须为 2–65536' : '3D 尺寸必须为 2–65')
      data = new Float32Array((kind === '1d' ? size : size ** 3) * 3)
    }
  }
  if (!data || !kind || rows !== data.length / 3) fail('样本数量与声明的表格尺寸不一致')
  const metadata = metadataValue({ name, domainMin, domainMax })
  return canonicalTable(data, size, kind, metadata, options)
}

/** The wire payload contains exactly the canonical RGB samples. Metadata is
 * carried separately; explicit little-endian IO avoids host-endian ambiguity. */
export function encodeColorLutTable(value: ColorLutTable, options: ColorLutWorkOptions = {}): Uint8Array {
  const table = tableValue(value, options), result = new Uint8Array(canonicalColorLutByteLength), view = new DataView(result.buffer)
  for (let index = 0; index < table.data.length; index++) { if (index % 3072 === 0) check(options); view.setFloat32(index * 4, table.data[index], true) }
  check(options)
  return result
}
export function decodeColorLutTable(bytes: Uint8Array, value: ColorLutTableMetadata, options: ColorLutWorkOptions = {}): ColorLutTable {
  check(options)
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== canonicalColorLutByteLength) fail('Float32LE 数据必须恰好为 431244 字节')
  const metadata = metadataValue(value), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), data = new Float32Array(canonicalColorLutSampleCount)
  for (let index = 0; index < data.length; index++) { if (index % 3072 === 0) check(options); data[index] = boundedValue(view.getFloat32(index * 4, true)) }
  check(options)
  return { version: 1, size: canonicalColorLutSize, ...metadata, data }
}

/** Freeze a validated table once per replay, rather than parsing or allocating
 * its 33³ samples for every pixel. Output remains float RGB; the final image
 * pipeline owns display clamping, alpha and transparent hidden RGB. */
export function createColorLutSampler(value: ColorLutTable, settings: ColorLutSamplingSettings, options: ColorLutWorkOptions = {}) {
  const table = tableValue(value, options)
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) || Object.keys(settings).some((key) => !['enabled', 'strength'].includes(key)) || typeof settings.enabled !== 'boolean' || typeof settings.strength !== 'number' || !Number.isFinite(settings.strength) || settings.strength < 0 || settings.strength > 100) fail('启用状态或强度无效，强度必须为 0–100')
  const strength = settings.enabled ? settings.strength / 100 : 0
  const domainMin = table.domainMin, spans = table.domainMax.map((maximum, channel) => maximum - domainMin[channel])
  return { sample(red: number, green: number, blue: number): ColorLutDomain {
    if (![red, green, blue].every(Number.isFinite)) fail('采样输入必须是有限 RGB 数值')
    if (strength === 0) return [red, green, blue]
    const rgb = [red, green, blue], normalized = rgb.map((value, channel) => Math.max(0, Math.min(1, (value - domainMin[channel]) / spans[channel])))
    const transformed = sample3d(table.data, canonicalColorLutSize, normalized[0], normalized[1], normalized[2])
    // Weighted terms preserve the exact lookup at 100%, including inputs far
    // outside its domain where a + (b - a) loses the small lookup by cancellation.
    return [red * (1 - strength) + transformed[0] * strength, green * (1 - strength) + transformed[1] * strength, blue * (1 - strength) + transformed[2] * strength]
  } }
}

import { describe, expect, it, vi } from 'vitest'
import { canonicalColorLutByteLength, canonicalColorLutSampleCount, createColorLutSampler, decodeColorLutTable, encodeColorLutTable, maximumColorLutCubeBytes, parseColorLutCube, type ColorLutTable } from './layer-color-lut'

// Explicit eight-corner fixture: its mixed corner cannot be reproduced by a
// per-channel curve, a matrix, a nearest-neighbour lookup or swapped axes.
const asymmetricCube = `# Owned analytical fixture, RGB red changes fastest.
TITLE "Own asymmetric # table"
LUT_3D_SIZE 2
0 0 0
1 0 0
0 1 0
0 0 1
.2 .3 .4
.7 .1 .9
.4 .8 .2
.9 .6 .5
`
const identityCube = `LUT_3D_SIZE 2
0 0 0
1 0 0
0 1 0
1 1 0
0 0 1
1 0 1
0 1 1
1 1 1`

function sample(text: string, rgb: [number, number, number], strength = 100) { return createColorLutSampler(parseColorLutCube(text), { enabled: true, strength }).sample(...rgb) }
function expectRgb(actual: number[], expected: number[], digits = 6) { expected.forEach((value, at) => expect(actual[at]).toBeCloseTo(value, digits)) }
function metadata(table: ColorLutTable) { return { name: table.name, domainMin: table.domainMin, domainMax: table.domainMax } }

describe('bounded IRIDAS Cube parsing and canonical LUT sampling', () => {
  it('parses independent explicit corners and performs true red-fastest trilinear interpolation', () => {
    const table = parseColorLutCube(asymmetricCube)
    expect(table).toMatchObject({ version: 1, size: 33, name: 'Own asymmetric # table', domainMin: [0, 0, 0], domainMax: [1, 1, 1] })
    expect(table.data).toBeInstanceOf(Float32Array)
    expect(table.data).toHaveLength(107811)
    expectRgb(sample(asymmetricCube, [.25, .5, .75]), [.35, .46875, .33125])
    expectRgb(sample(asymmetricCube, [1, 1, 0]), [0, 0, 1])
    expectRgb(sample(asymmetricCube, [0, 0, 1]), [.2, .3, .4])
    expectRgb(sample(asymmetricCube, [1, 0, 1]), [.7, .1, .9])
    expectRgb([...table.data.slice(3, 6)], [1 / 32, 0, 0])
    expectRgb([...table.data.slice(33 * 3, 33 * 3 + 3)], [0, 1 / 32, 0])
  })

  it('resamples nonlinear interior samples rather than taking only the original cube corners', () => {
    const rows: string[] = ['TITLE "Nonlinear interior"', 'LUT_3D_SIZE 3']
    for (const blue of [0, .5, 1]) for (const green of [0, .5, 1]) for (const red of [0, .5, 1]) rows.push(`${red * red} ${green * green} ${blue * blue}`)
    const table = parseColorLutCube(rows.join('\n')), sampler = createColorLutSampler(table, { enabled: true, strength: 100 })
    expectRgb(sampler.sample(.25, .5, .75), [.125, .25, .625])
    expectRgb([...table.data.slice(((24 * 33 + 16) * 33 + 8) * 3, ((24 * 33 + 16) * 33 + 8) * 3 + 3)], [.125, .25, .625])
    expectRgb(sampler.sample(.23, .37, .81), [.115, .185, .715])
  })

  it('expands a real 1D table with separate channel interpolation into a complete 33-cube', () => {
    const text = `TITLE "Separate channels"\nLUT_1D_SIZE 3\n0 1 .25\n.25 .5 .75\n1 0 1`
    const table = parseColorLutCube(text)
    expect(table.data).toHaveLength(canonicalColorLutSampleCount)
    expectRgb(sample(text, [.25, .5, .75]), [.125, .5, .875])
    expectRgb(sample(text, [.75, .25, .5]), [.625, .75, .75])
  })

  it('preserves asymmetric domains, maps each channel independently and clamps only outside the input domain', () => {
    const text = `DOMAIN_MAX 3 4 8\nDOMAIN_MIN -1 0 -8\n${identityCube}`
    const table = parseColorLutCube(text)
    expect(table.domainMin).toEqual([-1, 0, -8]); expect(table.domainMax).toEqual([3, 4, 8])
    const sampler = createColorLutSampler(table, { enabled: true, strength: 100 })
    expectRgb(sampler.sample(0, 2, 4), [.25, .5, .75])
    expectRgb(sampler.sample(-2, 5, 0), [0, 1, .5])
    expect(table.data[0]).toBe(0); expect(table.data.at(-1)).toBe(1)
  })

  it('accepts BOM, CRLF, comments, quoted hashes and finite exponent notation', () => {
    const text = '\uFEFF# header\r\nTITLE "Own \\"quote\\" # name" # comment\r\nDOMAIN_MIN -1.6e1 +0 .0\r\nDOMAIN_MAX 1.6E1 1. 1\r\nLUT_1D_SIZE 2\r\n-1.6e1 +0 .25 # row\r\n+1.6e1 1e0 .75\r\n'
    const table = parseColorLutCube(text)
    expect(table.name).toBe('Own "quote" # name')
    expect(table.domainMin).toEqual([-16, 0, 0])
    expectRgb(createColorLutSampler(table, { enabled: true, strength: 100 }).sample(0, .25, .5), [0, .25, .5])
  })

  it('retains finite HDR-like values instead of prematurely clipping the lookup output to display RGB', () => {
    const text = 'LUT_1D_SIZE 2\n-16 -2 1.5\n16 2 3'
    expectRgb(sample(text, [0, 1, 0]), [-16, 2, 1.5])
    expectRgb(sample(text, [1, 0, 1]), [16, -2, 3])
  })

  it.each([
    ['', /数量/], ['0 0 0\nLUT_1D_SIZE 2\n1 1 1', /样本前/], ['LUT_1D_SIZE 2\n0 0 0', /数量/], ['LUT_1D_SIZE 2\n0 0 0\n1 1 1\n.5 .5 .5', /数量/],
    ['LUT_1D_SIZE 2\n0 0\n1 1 1', /三个/], ['LUT_1D_SIZE 2\n0 0 0 0\n1 1 1', /三个/], ['LUT_1D_SIZE 2\n0 0 0\nTITLE "late"\n1 1 1', /开始后/],
    ['LUT_1D_SIZE 2\nLUT_3D_SIZE 2', /组合/], ['LUT_3D_SIZE 2\nLUT_1D_SIZE 2', /组合/], ['LUT_3D_SIZE 2\nLUT_3D_SIZE 2', /重复/],
    ['TITLE "one"\nTITLE "two"\nLUT_1D_SIZE 2\n0 0 0\n1 1 1', /重复/], ['DOMAIN_MIN 0 0 0\nDOMAIN_MIN 0 0 0\nLUT_1D_SIZE 2\n0 0 0\n1 1 1', /重复/],
    ['LUT_1D_INPUT_RANGE 0 1\nLUT_1D_SIZE 2\n0 0 0\n1 1 1', /不支持/], ['lut_1d_size 2\n0 0 0\n1 1 1', /不支持/], ['TITLE unquoted\nLUT_1D_SIZE 2\n0 0 0\n1 1 1', /双引号/],
    ['TITLE "unterminated\nLUT_1D_SIZE 2\n0 0 0\n1 1 1', /双引号/], ['TITLE ""\nLUT_1D_SIZE 2\n0 0 0\n1 1 1', /名称/], ['TITLE "bad\\nname"\nLUT_1D_SIZE 2\n0 0 0\n1 1 1', /双引号/],
    ['LUT_1D_SIZE 1', /2–65536/], ['LUT_1D_SIZE 65537', /2–65536/], ['LUT_3D_SIZE 1', /2–65/], ['LUT_3D_SIZE 66', /2–65/], ['LUT_3D_SIZE 2.0', /整数/], ['LUT_3D_SIZE 2e0', /整数/],
    ['LUT_1D_SIZE 2\n0 0 0\n1 NaN 1', /数值/], ['LUT_1D_SIZE 2\n0 0 0\n1 Infinity 1', /数值/], ['LUT_1D_SIZE 2\n0 0 0\n1 1e999 1', /有限数/],
    ['LUT_1D_SIZE 2\n0 0 0\n1 16.001 1', /有限数/], ['LUT_1D_SIZE 2\n0 0 0\n1 -16.001 1', /有限数/], ['LUT_1D_SIZE 2\n0 0 0\n1 0x1 1', /数值/],
    ['DOMAIN_MIN 0 0\nLUT_1D_SIZE 2\n0 0 0\n1 1 1', /三个/], ['DOMAIN_MIN 1 0 0\nLUT_1D_SIZE 2\n0 0 0\n1 1 1', /小于/], ['DOMAIN_MAX 1 -1 1\nLUT_1D_SIZE 2\n0 0 0\n1 1 1', /小于/],
    ['DOMAIN_MIN -17 0 0\nLUT_1D_SIZE 2\n0 0 0\n1 1 1', /有限数/], ['DOMAIN_MAX 1 16.001 1\nLUT_1D_SIZE 2\n0 0 0\n1 1 1', /有限数/],
    ['LUT_1D_SIZE 2\n0 0 0\n1 1 1\u0000', /字符/], ['LUT_1D_SIZE 2\n0 0 0\n1 1 1\ud800', /字符/], ['#' + 'x'.repeat(4096), /单行/],
  ])('rejects ambiguous, malformed or out-of-policy input: %s', (text, error) => { expect(() => parseColorLutCube(text as string)).toThrow(error) })

  it('checks actual UTF-8 bytes, not just UTF-16 length, before parsing', () => {
    expect(() => parseColorLutCube(' '.repeat(maximumColorLutCubeBytes + 1))).toThrow('24 MiB')
    expect(() => parseColorLutCube('中'.repeat(maximumColorLutCubeBytes / 3) + '中')).toThrow('24 MiB')
  })

  it('accepts the complete maximum 1D and 3D tables without dropping declared samples', () => {
    for (const header of ['LUT_1D_SIZE 65536', 'LUT_3D_SIZE 65']) {
      const rows = header.includes('1D') ? 65536 : 65 ** 3
      const table = parseColorLutCube(`${header}\n${'0 0 0\n'.repeat(rows)}`)
      expect(table.data).toHaveLength(canonicalColorLutSampleCount)
      expect(table.data.every((value) => value === 0)).toBe(true)
    }
  })

  it('honors cancellation and deadlines before and during header parsing and resampling', () => {
    const controller = new AbortController(); controller.abort()
    expect(() => parseColorLutCube(identityCube, { signal: controller.signal })).toThrow(/取消/)
    expect(() => parseColorLutCube(identityCube, { deadline: Date.now() - 1 })).toThrow(/超时/)
    const other = new AbortController(), aborted = vi.spyOn(other.signal, 'aborted', 'get')
    let checks = 0; aborted.mockImplementation(() => ++checks > 5)
    try { expect(() => parseColorLutCube(identityCube, { signal: other.signal })).toThrow(/取消/); expect(checks).toBeGreaterThan(5) } finally { aborted.mockRestore() }
    const duringRows = new AbortController(), rowAborted = vi.spyOn(duringRows.signal, 'aborted', 'get')
    let rowChecks = 0; rowAborted.mockImplementation(() => ++rowChecks > 4)
    try { expect(() => parseColorLutCube(`LUT_1D_SIZE 1024\n${'0 0 0\n'.repeat(1024)}`, { signal: duringRows.signal })).toThrow(/取消/); expect(rowChecks).toBeGreaterThan(4) } finally { rowAborted.mockRestore() }
  })
})

describe('canonical LUT byte codec and prepared kernel', () => {
  it('round-trips exact little-endian float bytes, metadata and subarray offsets without aliasing', () => {
    const table = parseColorLutCube(asymmetricCube); table.data[0] = .125; table.data[1] = -.25; table.data[2] = 16
    const bytes = encodeColorLutTable(table)
    expect(bytes).toHaveLength(canonicalColorLutByteLength)
    expect([...bytes.slice(0, 12)]).toEqual([0, 0, 0, 62, 0, 0, 128, 190, 0, 0, 128, 65])
    const padded = new Uint8Array(bytes.length + 11); padded.set(bytes, 7)
    const decoded = decodeColorLutTable(padded.subarray(7, 7 + bytes.length), metadata(table))
    expect(decoded).toEqual(table); expect(encodeColorLutTable(decoded)).toEqual(bytes)
    table.data[0] = 7; padded.fill(0); table.domainMin[0] = -1
    expect(decoded.data[0]).toBe(.125); expect(decoded.domainMin).toEqual([0, 0, 0])
  })

  it.each([0, canonicalColorLutByteLength - 4, canonicalColorLutByteLength + 4])('rejects a truncated or padded binary length %i', (length) => {
    expect(() => decodeColorLutTable(new Uint8Array(length), { name: 'Own', domainMin: [0, 0, 0], domainMax: [1, 1, 1] })).toThrow('431244')
  })

  it.each([NaN, Infinity, -Infinity, 16.1, -16.1])('rejects unsafe float payload or table value %s', (value) => {
    const table = parseColorLutCube(identityCube), bytes = encodeColorLutTable(table)
    new DataView(bytes.buffer).setFloat32(4 * 32767, value, true)
    expect(() => decodeColorLutTable(bytes, metadata(table))).toThrow(/有限数/)
    table.data[32767] = value
    expect(() => encodeColorLutTable(table)).toThrow(/有限数/)
    expect(() => createColorLutSampler(table, { enabled: true, strength: 100 })).toThrow(/有限数/)
  })

  it('rejects unknown versions, dimensions, metadata and malformed domains instead of coercing', () => {
    const table = parseColorLutCube(identityCube)
    for (const patch of [{ version: 2 }, { size: 32 }, { data: [] }, { data: new Float32Array(3) }, { url: 'https://invalid/' }, { name: '' }, { name: 'a'.repeat(161) }, { name: '\u0000' }, { domainMin: [0, 0] }, { domainMin: [1, 0, 0] }, { domainMax: [17, 1, 1] }, { domainMax: [1, Infinity, 1] }]) expect(() => encodeColorLutTable({ ...table, ...patch } as ColorLutTable)).toThrow(/LUT/)
    const unexpectedMetadata = { ...metadata(table), unexpected: true }
    expect(() => decodeColorLutTable(encodeColorLutTable(table), unexpectedMetadata)).toThrow(/元数据/)
  })

  it.each(['\ud800', '\udc00', 'own\ud800table', 'own\udc00table'])('rejects unpaired Unicode surrogates in runtime codec metadata %j', (name) => {
    const table = parseColorLutCube(identityCube), bytes = encodeColorLutTable(table)
    expect(() => encodeColorLutTable({ ...table, name })).toThrow(/名称/)
    expect(() => decodeColorLutTable(bytes, { ...metadata(table), name })).toThrow(/名称/)
  })

  it('preserves a valid emoji title through parsing and byte metadata round-trip', () => {
    const table = parseColorLutCube(`TITLE "Owned 🎨 LUT"\n${identityCube}`)
    expect(table.name).toBe('Owned 🎨 LUT')
    expect(decodeColorLutTable(encodeColorLutTable(table), metadata(table)).name).toBe('Owned 🎨 LUT')
  })

  it('uses enabled and 0–100 intensity with an immutable prepared table snapshot', () => {
    const table = parseColorLutCube(asymmetricCube), prepared = createColorLutSampler(table, { enabled: true, strength: 50 }), input: [number, number, number] = [.25, .5, .75]
    expectRgb(prepared.sample(...input), [.3, .484375, .540625])
    table.data.fill(16); table.domainMin.fill(-16); table.domainMax.fill(16)
    expectRgb(prepared.sample(...input), [.3, .484375, .540625])
    expect(createColorLutSampler(table, { enabled: false, strength: 100 }).sample(...input)).toEqual(input)
    expect(createColorLutSampler(table, { enabled: true, strength: 0 }).sample(...input)).toEqual(input)
  })

  it.each([{ enabled: true, strength: -1 }, { enabled: true, strength: 101 }, { enabled: true, strength: NaN }, { enabled: 'true', strength: 100 }, { enabled: true, strength: '50' }, { enabled: true, strength: 100, unknown: true }])('rejects malformed sampling controls %j', (settings) => {
    expect(() => createColorLutSampler(parseColorLutCube(identityCube), settings as { enabled: boolean; strength: number })).toThrow(/强度/)
  })

  it('rejects nonfinite sampling input and supports controlled byte preparation interruption', () => {
    const table = parseColorLutCube(identityCube), sampler = createColorLutSampler(table, { enabled: true, strength: 100 })
    expect(() => sampler.sample(NaN, 0, 0)).toThrow(/有限 RGB/)
    const controller = new AbortController(); controller.abort()
    expect(() => encodeColorLutTable(table, { signal: controller.signal })).toThrow(/取消/)
    expect(() => decodeColorLutTable(new Uint8Array(canonicalColorLutByteLength), metadata(table), { signal: controller.signal })).toThrow(/取消/)
    expect(() => createColorLutSampler(table, { enabled: true, strength: 100 }, { deadline: 0 })).toThrow(/超时/)
  })

  it('returns the exact clamped-domain lookup at full strength even for large finite out-of-domain inputs', () => {
    const sampler = createColorLutSampler(parseColorLutCube(identityCube), { enabled: true, strength: 100 })
    expect(sampler.sample(Number.MAX_VALUE, -Number.MAX_VALUE, Number.MAX_VALUE)).toEqual([1, 0, 1])
  })
})

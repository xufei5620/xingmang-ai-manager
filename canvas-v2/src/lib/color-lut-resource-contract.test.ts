import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { canonicalColorLutByteLength, canonicalColorLutSampleCount, encodeColorLutTable, parseColorLutCube, type ColorLutTable } from '../image-tools/layer-color-lut'
import { colorLutResourceDigest, colorLutResourceMimeType, describeColorLutResource, maximumColorLutResourceBytes, parseColorLutResource, parseColorLutResourceDescriptor, serializeColorLutResource } from './color-lut-resource-contract'

function table(name = '测试 LUT'): ColorLutTable {
  const data = new Float32Array(canonicalColorLutSampleCount)
  for (let index = 0; index < data.length; index++) data[index] = (index % 33) / 32
  data[0] = -0; data[1] = -0.5; data[2] = 1.25
  return { version: 1, size: 33, name, domainMin: [-1, -2, -3], domainMax: [2, 3, 4], data }
}
function utf8(value: unknown): Uint8Array { return new TextEncoder().encode(JSON.stringify(value)) }
function envelope(): Record<string, unknown> { return JSON.parse(new TextDecoder().decode(serializeColorLutResource(table()))) }
function descriptor() { return { version: 1, assetId: 'a'.repeat(43), digest: 'f'.repeat(64), size: 33, name: '测试 LUT', domainMin: [-1, -2, -3], domainMax: [2, 3, 4], byteSize: 575160, mimeType: colorLutResourceMimeType } }

describe('canonical LUT resource contract', () => {
  it('roundtrips all F32 bytes and canonical domains without mutating input', async () => {
    const input = table(), original = encodeColorLutTable(input), bytes = serializeColorLutResource(input), result = parseColorLutResource(bytes)
    expect(bytes.length).toBeLessThan(maximumColorLutResourceBytes)
    expect(bytes.length).toBeGreaterThan(canonicalColorLutByteLength)
    expect(Buffer.compare(Buffer.from(encodeColorLutTable(result)), Buffer.from(original))).toBe(0)
    expect(result.domainMin).toEqual([-1, -2, -3]); expect(result.domainMax).toEqual([2, 3, 4]); expect(result.name).toBe(input.name)
    expect(Object.is(result.data[0], -0)).toBe(true)
    result.data[1] = 9; result.domainMin[0] = -10
    expect(input.data[1]).toBe(-0.5); expect(input.domainMin[0]).toBe(-1)
    const details = await describeColorLutResource(bytes)
    expect(details).toMatchObject({ version: 1, size: 33, name: input.name, byteSize: bytes.length, mimeType: colorLutResourceMimeType })
    expect(details).not.toHaveProperty('assetId')
    expect(details.digest).toBe(createHash('sha256').update(bytes).digest('hex'))
  })
  it('includes names and input domains in the full canonical digest', async () => {
    const a = table(), b = { ...a, name: '另一名称' }, c: ColorLutTable = { ...a, domainMin: [-2, -2, -3] }
    expect(Buffer.compare(Buffer.from(encodeColorLutTable(a)), Buffer.from(encodeColorLutTable(c)))).toBe(0)
    const hashes = await Promise.all([a, b, c].map((value) => colorLutResourceDigest(serializeColorLutResource(value))))
    expect(new Set(hashes).size).toBe(3)
  })
  it.each(['1D', '3D'])('retains the actual core %s resampling output at canonical 33 cubed', (kind) => {
    const rows = kind === '1D' ? ['1 1 1', '0 0 0'] : Array.from({ length: 8 }, (_, i) => `${1 - (i & 1)} ${1 - ((i >> 1) & 1)} ${1 - ((i >> 2) & 1)}`)
    const input = parseColorLutCube(`TITLE "反色"\nLUT_${kind}_SIZE 2\n${rows.join('\n')}`)
    const actual = parseColorLutResource(serializeColorLutResource(input))
    expect(actual.size).toBe(33); expect(actual.data.length).toBe(107811)
    expect(Array.from(actual.data.subarray(0, 3))).toEqual([1, 1, 1])
    expect(Array.from(actual.data.subarray(-3))).toEqual([0, 0, 0])
    expect(Buffer.compare(Buffer.from(encodeColorLutTable(input)), Buffer.from(encodeColorLutTable(actual)))).toBe(0)
  })
  it.each([
    ['future version', { version: 2 }], ['null version', { version: null }], ['smaller table', { size: 17 }],
    ['foreign format', { format: 'cube' }], ['extra field', { ownerId: 7 }], ['empty name', { name: '' }],
    ['control in name', { name: 'bad\nname' }], ['surrogate in name', { name: '\ud800' }],
    ['inverted domain', { domainMin: [1, 0, 0], domainMax: [1, 1, 1] }], ['oversized domain', { domainMax: [17, 1, 1] }],
    ['null domain', { domainMin: null }], ['nonfinite domain', { domainMax: [Infinity, 1, 1] }],
    ['unknown data', { data: null }], ['wrong data length', { data: 'AAAA' }],
  ])('rejects %s without silently replacing parameters', (_name, change) => { expect(() => parseColorLutResource(utf8({ ...envelope(), ...change }))).toThrow() })
  it('rejects nonfinite and excessive F32 values in otherwise canonical binary', () => {
    for (const value of [NaN, Infinity, -Infinity, 17, -17]) {
      const raw = envelope(), bytes = Buffer.from(raw.data as string, 'base64')
      bytes.writeFloatLE(value, 4); raw.data = bytes.toString('base64')
      expect(() => parseColorLutResource(utf8(raw))).toThrow()
    }
  })
  it('requires exact canonical JSON and base64 rather than accepting alternate identities', () => {
    const raw = envelope(), text = JSON.stringify(raw)
    const variants = [' ' + text, JSON.stringify(raw, null, 2), JSON.stringify({ data: raw.data, ...raw }), text.replace('"version":1', '"version":1,"version":1'), text.replace('"name":"测试 LUT"', '"name":" 测试 LUT "')]
    const reordered = { data: raw.data, format: raw.format, version: raw.version, size: raw.size, name: raw.name, domainMin: raw.domainMin, domainMax: raw.domainMax }
    variants.push(JSON.stringify(reordered), JSON.stringify({ ...raw, data: (raw.data as string).slice(0, -1) + '=' }))
    // An existing key in an object spread does not move; only genuinely different JSON representations fail.
    for (const variant of variants.filter((value) => value !== text)) expect(() => parseColorLutResource(new TextEncoder().encode(variant))).toThrow()
    expect(() => parseColorLutResource(new Uint8Array([0xff]))).toThrow()
    expect(() => parseColorLutResource(new Uint8Array(maximumColorLutResourceBytes + 1))).toThrow(/640/)
    expect(() => parseColorLutResource(new Uint8Array())).toThrow(/640/)
  })
  it('checks cancellation and real elapsed deadlines before publishing digests', async () => {
    const bytes = serializeColorLutResource(table()), controller = new AbortController()
    controller.abort(new DOMException('取消', 'AbortError'))
    expect(() => serializeColorLutResource(table(), { signal: controller.signal })).toThrow(/取消/)
    expect(() => parseColorLutResource(bytes, { deadline: Date.now() - 1 })).toThrow(/超时/)
    await expect(describeColorLutResource(bytes, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    const original = crypto.subtle.digest.bind(crypto.subtle), late = new AbortController()
    const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (algorithm, data) => { const result = await original(algorithm, data); late.abort(new DOMException('取消', 'AbortError')); return result })
    try { await expect(colorLutResourceDigest(bytes, { signal: late.signal })).rejects.toMatchObject({ name: 'AbortError' }) } finally { spy.mockRestore() }
  })
})

describe('immutable LUT descriptor', () => {
  it('compares semantic fields independently of object property order and returns clones', () => {
    const input = descriptor(), result = parseColorLutResourceDescriptor(Object.fromEntries(Object.entries(input).reverse()))
    expect(result).toEqual(input); result.domainMin[0] = -8; expect(input.domainMin[0]).toBe(-1)
    expect(parseColorLutResourceDescriptor({ ...input, name: '有效 emoji 🎨' }).name).toBe('有效 emoji 🎨')
  })
  it.each([
    ['extra owner', { ownerId: 8 }], ['future version', { version: 2 }], ['noncanonical name', { name: ' bad ' }], ['control name', { name: 'bad\0' }],
    ['surrogate name', { name: '\ud800' }], ['bad id', { assetId: '../foreign' }], ['bad digest', { digest: 'F'.repeat(64) }],
    ['wrong MIME', { mimeType: 'image/png' }], ['wrong size', { size: 17 }], ['invalid domain', { domainMin: [0, 0, 0], domainMax: [0, 1, 1] }],
    ['nonfinite domain', { domainMax: [Infinity, 1, 1] }], ['bad capacity', { byteSize: 1 }], ['excess capacity', { byteSize: maximumColorLutResourceBytes + 1 }],
  ])('rejects %s', (_name, change) => { expect(() => parseColorLutResourceDescriptor({ ...descriptor(), ...change })).toThrow() })
})

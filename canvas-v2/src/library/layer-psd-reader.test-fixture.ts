interface PsdFixtureLayer {
  name?: string
  width?: number
  height?: number
  left?: number
  top?: number
  pixels?: number[]
  opacity?: number
  flags?: number
  blend?: string
  clipping?: number
  channelIds?: number[]
  compression?: number
  packedRows?: number[][]
  tags?: Array<{ key: string; data: number[] }>
  mask?: number[]
  ranges?: number[]
}
export interface PsdFixtureOptions {
  width?: number
  height?: number
  channels?: number
  depth?: number
  mode?: number
  version?: number
  layers?: PsdFixtureLayer[]
  resources?: Array<{ id: number; data: number[] }>
  compositeCompression?: number
  infoPadding?: number
  globalMask?: number[]
}
export function fixtureU16(value: number): number[] { return [(value >>> 8) & 255, value & 255] }
export function fixtureU32(value: number): number[] { return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255] }
function ascii(value: string): number[] { return [...value].map((character) => character.charCodeAt(0)) }
function section(bytes: number[]): number[] { return [...fixtureU32(bytes.length), ...bytes] }
function tag(key: string, data: number[]): number[] { return [...ascii('8BIM' + key), ...section(data), ...(data.length % 2 ? [0] : [])] }
function literal(values: number[]): number[] {
  const result: number[] = []
  for (let offset = 0; offset < values.length; offset += 128) { const part = values.slice(offset, offset + 128); result.push(part.length - 1, ...part) }
  return result
}

/** Tiny independently assembled Adobe structure; no parser/encoder offsets reused. */
export function buildPsdReaderFixture(options: PsdFixtureOptions = {}): Uint8Array<ArrayBuffer> {
  const width = options.width ?? 2, height = options.height ?? 1, channels = options.channels ?? 4
  const records: number[] = [], planes: number[] = [], layers = options.layers ?? [{ name: '底层', pixels: [10, 20, 30, 128, 40, 50, 60, 255] }]
  for (const layer of layers) {
    const w = layer.width ?? width, h = layer.height ?? height, left = layer.left ?? 0, top = layer.top ?? 0, ids = layer.channelIds ?? [0, 1, 2, -1]
    const samples = layer.pixels ?? Array.from({ length: Math.min(w * h * 4, 20000) }, (_, index) => (index % 4 === 3 ? 255 : index % 251))
    const descriptors: number[] = []
    for (const id of ids) {
      const channel = id === -1 ? 3 : id, raw = Array.from({ length: Math.min(w * h, 5000) }, (_, index) => samples[index * 4 + channel] ?? 0), compression = layer.compression ?? 0
      let payload = raw
      if (compression === 1) {
        const rows = Array.from({ length: Math.min(h, 5000) }, (_, index) => layer.packedRows?.[index] ?? literal(raw.slice(index * w, (index + 1) * w)))
        payload = [...rows.flatMap((row) => fixtureU16(row.length)), ...rows.flat()]
      }
      const encoded = [...fixtureU16(compression), ...payload]
      descriptors.push(...fixtureU16(id), ...fixtureU32(encoded.length)); planes.push(...encoded)
    }
    const name = layer.name ?? '图层', unicode = [...fixtureU32(name.length), ...Array.from({ length: name.length }, (_, index) => fixtureU16(name.charCodeAt(index))).flat()]
    const extra = [...section(layer.mask ?? []), ...section(layer.ranges ?? []), 0, 0, 0, 0, ...tag('luni', unicode), ...(layer.tags ?? []).flatMap(({ key, data }) => tag(key, data))]
    records.push(...fixtureU32(top), ...fixtureU32(left), ...fixtureU32(top + h), ...fixtureU32(left + w), ...fixtureU16(ids.length), ...descriptors, ...ascii('8BIM' + (layer.blend ?? 'norm')), layer.opacity ?? 255, layer.clipping ?? 0, layer.flags ?? 8, 0, ...section(extra))
  }
  const info = [...fixtureU16(channels === 4 ? -layers.length : layers.length), ...records, ...planes]
  const padding = options.infoPadding ?? info.length % 2
  const layerSection = [...section([...info, ...Array.from({ length: padding }, () => 0)]), ...section(options.globalMask ?? [])]
  const resources = (options.resources ?? []).flatMap(({ id, data }) => [...ascii('8BIM'), ...fixtureU16(id), 0, 0, ...section(data), ...(data.length % 2 ? [0] : [])])
  const compositeCompression = options.compositeCompression ?? 0
  let composite = Array.from({ length: Math.min(width * height * channels, 20000) }, () => 0)
  if (compositeCompression === 1) {
    const rows = Array.from({ length: Math.min(height * channels, 5000) }, () => literal(Array.from({ length: Math.min(width, 5000) }, () => 0)))
    composite = [...rows.flatMap((row) => fixtureU16(row.length)), ...rows.flat()]
  }
  return new Uint8Array([...ascii('8BPS'), ...fixtureU16(options.version ?? 1), 0, 0, 0, 0, 0, 0, ...fixtureU16(channels), ...fixtureU32(height), ...fixtureU32(width), ...fixtureU16(options.depth ?? 8), ...fixtureU16(options.mode ?? 3), ...section([]), ...section(resources), ...section(layerSection), ...fixtureU16(compositeCompression), ...composite])
}

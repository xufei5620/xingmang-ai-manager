import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readMacosExecutableArchitectures } from './macos-executable-architectures'

type ByteOrder = 'big' | 'little'
type HeaderWidth = 32 | 64

const arm64 = 0x0100000c
const x86_64 = 0x01000007
const directories: string[] = []

function write32(buffer: Buffer, value: number, offset: number, order: ByteOrder): void {
  if (order === 'little') buffer.writeUInt32LE(value, offset)
  else buffer.writeUInt32BE(value, offset)
}

function write64(buffer: Buffer, value: bigint, offset: number, order: ByteOrder): void {
  if (order === 'little') buffer.writeBigUInt64LE(value, offset)
  else buffer.writeBigUInt64BE(value, offset)
}

interface ThinOptions {
  cpu?: number
  subtype?: number
  width?: HeaderWidth
  order?: ByteOrder
  fileType?: number
  commandCount?: number
  commandsSize?: number
  extraBytes?: number
}

function thin(options: ThinOptions = {}): Buffer {
  const width = options.width ?? 64
  const order = options.order ?? 'little'
  const headerSize = width === 64 ? 32 : 28
  const buffer = Buffer.alloc(headerSize + (options.extraBytes ?? 0))
  write32(buffer, width === 64 ? 0xfeedfacf : 0xfeedface, 0, order)
  write32(buffer, options.cpu ?? (width === 64 ? arm64 : 7), 4, order)
  write32(buffer, options.subtype ?? 0, 8, order)
  write32(buffer, options.fileType ?? 2, 12, order)
  write32(buffer, options.commandCount ?? 0, 16, order)
  write32(buffer, options.commandsSize ?? 0, 20, order)
  return buffer
}

interface Slice {
  cpu: number
  subtype?: number
  bytes: Buffer
}

interface FatFixture {
  buffer: Buffer
  width: HeaderWidth
  order: ByteOrder
  records: number[]
  offsets: number[]
}

function fat(slices: readonly Slice[], width: HeaderWidth = 32, order: ByteOrder = 'big'): FatFixture {
  const entrySize = width === 64 ? 32 : 20
  const records = slices.map((_, index) => 8 + index * entrySize)
  const offsets = slices.map((_, index) => (index + 1) * 256)
  const size = slices.length ? offsets.at(-1)! + slices.at(-1)!.bytes.length : 8
  const buffer = Buffer.alloc(size)
  write32(buffer, width === 64 ? 0xcafebabf : 0xcafebabe, 0, order)
  write32(buffer, slices.length, 4, order)
  slices.forEach((slice, index) => {
    const record = records[index]
    write32(buffer, slice.cpu, record, order)
    write32(buffer, slice.subtype ?? 0, record + 4, order)
    if (width === 64) {
      write64(buffer, BigInt(offsets[index]), record + 8, order)
      write64(buffer, BigInt(slice.bytes.length), record + 16, order)
    } else {
      write32(buffer, offsets[index], record + 8, order)
      write32(buffer, slice.bytes.length, record + 12, order)
    }
    write32(buffer, 8, record + (width === 64 ? 24 : 16), order)
    slice.bytes.copy(buffer, offsets[index])
  })
  return { buffer, width, order, records, offsets }
}

function setSliceOffset(fixture: FatFixture, index: number, offset: bigint): void {
  const position = fixture.records[index] + 8
  if (fixture.width === 64) write64(fixture.buffer, offset, position, fixture.order)
  else write32(fixture.buffer, Number(offset), position, fixture.order)
}

function setSliceSize(fixture: FatFixture, index: number, size: bigint): void {
  const position = fixture.records[index] + (fixture.width === 64 ? 16 : 12)
  if (fixture.width === 64) write64(fixture.buffer, size, position, fixture.order)
  else write32(fixture.buffer, Number(size), position, fixture.order)
}

function setSliceAlignment(fixture: FatFixture, index: number, exponent: number): void {
  write32(fixture.buffer, exponent, fixture.records[index] + (fixture.width === 64 ? 24 : 16), fixture.order)
}

function inspect(buffer: Buffer): Promise<readonly string[]> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-macho-architectures-'))
  directories.push(directory)
  const executablePath = path.join(directory, 'Codex')
  fs.writeFileSync(executablePath, buffer)
  return readMacosExecutableArchitectures(executablePath)
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('readMacosExecutableArchitectures', () => {
  it.each([
    { cpu: arm64, name: 'arm64', order: 'little' },
    { cpu: arm64, name: 'arm64', order: 'big' },
    { cpu: x86_64, name: 'x86_64', order: 'little' },
    { cpu: x86_64, name: 'x86_64', order: 'big' },
  ] as const)('reads a $order endian thin $name executable', async ({ cpu, name, order }) => {
    await expect(inspect(thin({ cpu, order }))).resolves.toEqual([name])
  })

  it('reads FAT_MAGIC, FAT_MAGIC_64, and both byte-swapped tables', async () => {
    for (const width of [32, 64] as const) {
      for (const order of ['big', 'little'] as const) {
        const fixture = fat([{ cpu: arm64, bytes: thin() }], width, order)
        await expect(inspect(fixture.buffer)).resolves.toEqual(['arm64'])
      }
    }
  })

  it('returns every supported architecture from a universal executable', async () => {
    const fixture = fat([
      { cpu: x86_64, bytes: thin({ cpu: x86_64, order: 'big' }) },
      { cpu: arm64, bytes: thin() },
    ])
    expect(new Set(await inspect(fixture.buffer))).toEqual(new Set(['x86_64', 'arm64']))
  })

  it('accepts distinct subtypes of one CPU and returns that architecture once', async () => {
    const fixture = fat([
      { cpu: x86_64, subtype: 3, bytes: thin({ cpu: x86_64, subtype: 3 }) },
      { cpu: x86_64, subtype: 8, bytes: thin({ cpu: x86_64, subtype: 8 }) },
    ])
    await expect(inspect(fixture.buffer)).resolves.toEqual(['x86_64'])
  })

  it('accepts valid unsupported CPU types without reporting a supported architecture', async () => {
    for (const options of [
      { cpu: 7, width: 32, order: 'little' },
      { cpu: 7, width: 32, order: 'big' },
      { cpu: 0x01000012, width: 64 },
      { cpu: 0x0200000c, width: 64 },
    ] as const) {
      await expect(inspect(thin(options))).resolves.toEqual([])
      await expect(inspect(fat([{ cpu: options.cpu, bytes: thin(options) }]).buffer)).resolves.toEqual([])
    }
  })

  it('rejects missing or unrecognized Mach-O magic', async () => {
    for (const buffer of [Buffer.alloc(0), Buffer.from([0xcf, 0xfa]), Buffer.from('not a Mach-O executable'.padEnd(32, '\0'))]) {
      await expect(inspect(buffer)).rejects.toThrow()
    }
  })

  it('rejects truncated thin headers in either byte order', async () => {
    for (const width of [32, 64] as const) {
      for (const order of ['big', 'little'] as const) {
        const buffer = thin({ width, order })
        await expect(inspect(buffer.subarray(0, buffer.length - 1))).rejects.toThrow()
      }
    }
  })

  it('rejects a fat table with zero or more than 64 slices', async () => {
    for (const width of [32, 64] as const) {
      for (const count of [0, 65]) {
        const fixture = fat([{ cpu: arm64, bytes: thin() }], width)
        write32(fixture.buffer, count, 4, fixture.order)
        await expect(inspect(fixture.buffer)).rejects.toThrow()
      }
    }
  })

  it('rejects a truncated fat header or architecture table', async () => {
    for (const width of [32, 64] as const) {
      const fixture = fat([{ cpu: arm64, bytes: thin() }], width)
      await expect(inspect(fixture.buffer.subarray(0, 7))).rejects.toThrow()
      await expect(inspect(fixture.buffer.subarray(0, 8 + (width === 64 ? 32 : 20) - 1))).rejects.toThrow()
    }
  })

  it('rejects out-of-range slice offsets and sizes without losing 64-bit precision', async () => {
    for (const width of [32, 64] as const) {
      for (const mutation of ['offset', 'size', 'empty', 'short'] as const) {
        const fixture = fat([{ cpu: arm64, bytes: thin() }], width)
        if (mutation === 'offset') setSliceOffset(fixture, 0, width === 64 ? (1n << 53n) + 256n : 512n)
        if (mutation === 'size') setSliceSize(fixture, 0, width === 64 ? (1n << 64n) - 1n : 33n)
        if (mutation === 'empty') setSliceSize(fixture, 0, 0n)
        if (mutation === 'short') setSliceSize(fixture, 0, 31n)
        await expect(inspect(fixture.buffer)).rejects.toThrow()
      }
    }
  })

  it('rejects slices whose range covers the fat architecture table', async () => {
    for (const width of [32, 64] as const) {
      const fixture = fat([{ cpu: arm64, bytes: thin() }], width)
      setSliceOffset(fixture, 0, 8n)
      setSliceAlignment(fixture, 0, 0)
      await expect(inspect(fixture.buffer)).rejects.toThrow()
    }
  })

  it('rejects overlapping slices even when both headers are valid', async () => {
    const fixture = fat([
      { cpu: arm64, bytes: thin() },
      { cpu: x86_64, bytes: thin({ cpu: x86_64 }) },
    ])
    setSliceSize(fixture, 0, BigInt(fixture.offsets[1] - fixture.offsets[0] + 1))
    await expect(inspect(fixture.buffer)).rejects.toThrow()
  })

  it('rejects duplicate CPU and subtype pairs', async () => {
    const fixture = fat([
      { cpu: arm64, bytes: thin() },
      { cpu: arm64, bytes: thin() },
    ])
    await expect(inspect(fixture.buffer)).rejects.toThrow()
  })

  it('rejects slice CPU or subtype declarations that disagree with their Mach-O headers', async () => {
    for (const slice of [
      { cpu: arm64, bytes: thin({ cpu: x86_64 }) },
      { cpu: x86_64, subtype: 3, bytes: thin({ cpu: x86_64, subtype: 8 }) },
    ]) {
      await expect(inspect(fat([slice]).buffer)).rejects.toThrow()
    }
  })

  it('rejects CPU ABI flags that disagree with the thin or slice header width', async () => {
    for (const options of [{ cpu: arm64, width: 32 }, { cpu: 7, width: 64 }, { cpu: 0x0200000c, width: 32 }] as const) {
      await expect(inspect(thin(options))).rejects.toThrow()
      await expect(inspect(fat([{ cpu: options.cpu, bytes: thin(options) }]).buffer)).rejects.toThrow()
    }
  })

  it('rejects Mach-O libraries and object files instead of accepting them as executables', async () => {
    for (const fileType of [1, 6]) {
      const buffer = thin({ fileType })
      await expect(inspect(buffer)).rejects.toThrow()
      await expect(inspect(fat([{ cpu: arm64, bytes: buffer }]).buffer)).rejects.toThrow()
    }
  })

  it('rejects inconsistent command counts and command ranges extending beyond a thin file', async () => {
    for (const options of [
      { commandCount: 1, commandsSize: 8 },
      { commandCount: 2, commandsSize: 8, extraBytes: 8 },
      { commandCount: 0, commandsSize: 8, extraBytes: 8 },
      { commandCount: 1, commandsSize: 0 },
    ]) {
      await expect(inspect(thin(options))).rejects.toThrow()
    }
  })

  it('checks command ranges against each slice, not merely the enclosing fat file', async () => {
    const fixture = fat([
      { cpu: arm64, bytes: thin({ commandCount: 1, commandsSize: 8 }) },
      { cpu: x86_64, bytes: thin({ cpu: x86_64 }) },
    ])
    await expect(inspect(fixture.buffer)).rejects.toThrow()
  })

  it('rejects alignment exponents wider than the fat offset field', async () => {
    for (const width of [32, 64] as const) {
      const fixture = fat([{ cpu: arm64, bytes: thin() }], width)
      setSliceAlignment(fixture, 0, width)
      await expect(inspect(fixture.buffer)).rejects.toThrow()
    }
  })

  it('rejects a slice offset that does not satisfy its declared alignment', async () => {
    for (const width of [32, 64] as const) {
      const fixture = fat([{ cpu: arm64, bytes: thin() }], width)
      setSliceAlignment(fixture, 0, 9)
      await expect(inspect(fixture.buffer)).rejects.toThrow()
    }
  })

  it('validates unsupported slices before returning architectures from valid ones', async () => {
    const fixture = fat([
      { cpu: arm64, bytes: thin() },
      { cpu: 7, bytes: Buffer.alloc(32) },
    ])
    await expect(inspect(fixture.buffer)).rejects.toThrow()
  })

  it('accepts command ranges ending exactly at the file or slice boundary', async () => {
    const buffer = thin({ commandCount: 1, commandsSize: 8, extraBytes: 8 })
    await expect(inspect(buffer)).resolves.toEqual(['arm64'])
    await expect(inspect(fat([{ cpu: arm64, bytes: buffer }]).buffer)).resolves.toEqual(['arm64'])
  })
})

import { open, type FileHandle } from 'node:fs/promises'

const maximumFatArchitectures = 64
const cpuX86_64 = 0x01000007
const cpuArm64 = 0x0100000c

interface MachHeaderFormat { littleEndian: boolean; is64Bit: boolean }
interface FatHeaderFormat extends MachHeaderFormat { entryBytes: number }
interface Slice { offset: bigint; size: bigint; cpuType: number; cpuSubtype: number }

function invalidExecutable(): Error {
  return new Error('Codex 可执行文件的 Mach-O 头或架构表无效、截断或越界')
}

function machHeaderFormat(magic: number): MachHeaderFormat | null {
  switch (magic) {
    case 0xfeedface: return { littleEndian: false, is64Bit: false }
    case 0xcefaedfe: return { littleEndian: true, is64Bit: false }
    case 0xfeedfacf: return { littleEndian: false, is64Bit: true }
    case 0xcffaedfe: return { littleEndian: true, is64Bit: true }
    default: return null
  }
}

function fatHeaderFormat(magic: number): FatHeaderFormat | null {
  switch (magic) {
    case 0xcafebabe: return { littleEndian: false, is64Bit: false, entryBytes: 20 }
    case 0xbebafeca: return { littleEndian: true, is64Bit: false, entryBytes: 20 }
    case 0xcafebabf: return { littleEndian: false, is64Bit: true, entryBytes: 32 }
    case 0xbfbafeca: return { littleEndian: true, is64Bit: true, entryBytes: 32 }
    default: return null
  }
}

function uint32(buffer: Buffer, offset: number, littleEndian: boolean): number {
  return littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset)
}

function uint64(buffer: Buffer, offset: number, littleEndian: boolean): bigint {
  return littleEndian ? buffer.readBigUInt64LE(offset) : buffer.readBigUInt64BE(offset)
}

async function readExactly(file: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length)
  let read = 0
  while (read < length) {
    const result = await file.read(buffer, read, length - read, position + read)
    if (result.bytesRead === 0) throw invalidExecutable()
    read += result.bytesRead
  }
  return buffer
}

async function inspectMachHeader(
  file: FileHandle,
  offset: number,
  size: bigint,
  expected?: Slice,
): Promise<string | null> {
  if (size < 4n) throw invalidExecutable()
  const magic = (await readExactly(file, offset, 4)).readUInt32BE(0)
  const format = machHeaderFormat(magic)
  if (!format) throw invalidExecutable()
  const headerBytes = format.is64Bit ? 32 : 28
  if (size < BigInt(headerBytes)) throw invalidExecutable()
  const header = await readExactly(file, offset, headerBytes)
  const cpuType = uint32(header, 4, format.littleEndian)
  const cpuSubtype = uint32(header, 8, format.littleEndian)
  const fileType = uint32(header, 12, format.littleEndian)
  const commandCount = uint32(header, 16, format.littleEndian)
  const commandBytes = uint32(header, 20, format.littleEndian)
  if (
    fileType !== 2 // MH_EXECUTE: do not mistake a dylib/object for an app executable.
    || Boolean(cpuType & 0x03000000) !== format.is64Bit
    || BigInt(headerBytes) + BigInt(commandBytes) > size
    || commandCount * 8 > commandBytes
    || (commandCount === 0 && commandBytes !== 0)
    || (expected && (cpuType !== expected.cpuType || cpuSubtype !== expected.cpuSubtype))
  ) throw invalidExecutable()
  if (cpuType === cpuArm64) return 'arm64'
  if (cpuType === cpuX86_64) return 'x86_64'
  return null
}

/**
 * Read only bounded Mach-O headers and the fat architecture table. macOS lipo
 * can be a developer-tools shim, so installed-app detection must not invoke it.
 * This identifies architecture only; the caller must still verify code signing.
 */
export async function readMacosExecutableArchitectures(executablePath: string): Promise<readonly string[]> {
  const file = await open(executablePath, 'r')
  try {
    const stats = await file.stat()
    if (!stats.isFile() || !Number.isSafeInteger(stats.size) || stats.size < 4) throw invalidExecutable()
    const fileSize = BigInt(stats.size)
    const magic = (await readExactly(file, 0, 4)).readUInt32BE(0)
    const fat = fatHeaderFormat(magic)
    if (!fat) {
      const architecture = await inspectMachHeader(file, 0, fileSize)
      return architecture ? [architecture] : []
    }

    const header = await readExactly(file, 0, 8)
    const count = uint32(header, 4, fat.littleEndian)
    if (count === 0 || count > maximumFatArchitectures) throw invalidExecutable()
    const tableEnd = 8 + count * fat.entryBytes
    if (BigInt(tableEnd) > fileSize) throw invalidExecutable()
    const table = await readExactly(file, 8, count * fat.entryBytes)
    const slices: Slice[] = []
    const identities = new Set<string>()
    for (let index = 0; index < count; index += 1) {
      const start = index * fat.entryBytes
      const cpuType = uint32(table, start, fat.littleEndian)
      const cpuSubtype = uint32(table, start + 4, fat.littleEndian)
      const offset = fat.is64Bit
        ? uint64(table, start + 8, fat.littleEndian)
        : BigInt(uint32(table, start + 8, fat.littleEndian))
      const size = fat.is64Bit
        ? uint64(table, start + 16, fat.littleEndian)
        : BigInt(uint32(table, start + 12, fat.littleEndian))
      const alignment = uint32(table, start + (fat.is64Bit ? 24 : 16), fat.littleEndian)
      const identity = `${cpuType}:${cpuSubtype}`
      if (
        offset < BigInt(tableEnd)
        || size < 28n
        || offset + size > fileSize
        || alignment > (fat.is64Bit ? 63 : 31)
        || offset % (1n << BigInt(alignment)) !== 0n
        || (fat.is64Bit && uint32(table, start + 28, fat.littleEndian) !== 0)
        || identities.has(identity)
        || slices.some((slice) => offset < slice.offset + slice.size && slice.offset < offset + size)
      ) throw invalidExecutable()
      identities.add(identity)
      slices.push({ offset, size, cpuType, cpuSubtype })
    }

    const architectures = new Set<string>()
    for (const slice of slices) {
      // All offsets are within a stat size proven to be a safe JS integer.
      const architecture = await inspectMachHeader(file, Number(slice.offset), slice.size, slice)
      if (architecture) architectures.add(architecture)
    }
    return [...architectures]
  } finally {
    await file.close()
  }
}

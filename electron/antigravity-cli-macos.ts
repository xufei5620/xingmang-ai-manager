import fs from 'node:fs'
import zlib from 'node:zlib'
import type { CommandResult } from './command-runner'
import { CommandRunnerError } from './command-runner'
import { DarwinCliProvenanceError, darwinDeveloperIdVerificationArgv } from './macos-code-signing'

/**
 * Mac 上的 agy：谷歌的 tar.gz 里只有一个 `antigravity`（11-23 在 GitHub 的机器上逐条列过：GNU 格式、一条普通
 * 文件、权限 0755、没有 pax 头），解出来放成 `~/.local/bin/agy`。
 *
 * Trust: the archive is read here, in Node, rather than handed to tar: one regular file named
 * `antigravity` is the only thing ever written, its size is capped, and links, devices and any
 * second file make the whole archive unacceptable, so a crafted archive can neither write outside
 * the one destination nor fill the disk. The written file is then accepted only when codesign's
 * exit status says it satisfies Google's Developer ID requirement (identifier `cli`, team
 * EQHXZ8M8AV, the same one scripts/sync-antigravity-cli-cos.cjs checks), and its Mach-O header
 * names this Mac's processor. The chip is read from the header, not from lipo: on a Mac without
 * Xcode's command line tools /usr/bin/lipo is a stub that offers to install them.
 */

export const antigravityCliTeamIdentifier = 'EQHXZ8M8AV'
export const antigravityCliCodeIdentifier = 'cli'
const archiveExecutableName = 'antigravity'
const blockBytes = 512
// 1.5.15 解开是两百二三十 MB；上限和下载的上限一样。
export const maximumAntigravityCliExecutableBytes = 512 * 1024 * 1024
// A single small file needs a handful of header blocks; anything beyond is not this archive.
const maximumHeaderBlocks = 16
const codesignTimeoutMs = 2 * 60_000

export class AntigravityCliArchiveError extends Error {
  constructor(detail: string) {
    super(`Antigravity 命令行安装包格式不对：${detail}`)
    this.name = 'AntigravityCliArchiveError'
  }
}

function readOctal(field: Buffer): number | null {
  const text = field.toString('latin1').replace(/[\0 ]+$/, '').replace(/^ +/, '')
  if (!/^[0-7]{1,12}$/.test(text)) return null
  const value = Number.parseInt(text, 8)
  return Number.isSafeInteger(value) ? value : null
}

function headerChecksumMatches(header: Buffer): boolean {
  const recorded = readOctal(header.subarray(148, 156))
  if (recorded === null) return false
  let sum = 0
  for (let index = 0; index < blockBytes; index += 1) sum += index >= 148 && index < 156 ? 0x20 : header[index]
  return sum === recorded
}

function entryName(header: Buffer): string {
  const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '')
  const magic = header.subarray(257, 263).toString('latin1')
  // POSIX ustar splits long names into prefix/name; GNU tar ("ustar  ") has no prefix field there.
  const prefix = magic === 'ustar\0' ? header.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '') : ''
  return prefix ? `${prefix}/${name}` : name
}

function normalizedName(name: string): string {
  return name.replace(/^(?:\.\/)+/, '')
}

// pax records are "<length> <key>=<value>\n". Only the file name may be overridden there.
function readPaxPath(data: Buffer): string | null {
  let path: string | null = null
  let offset = 0
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset)
    if (space < 0) throw new AntigravityCliArchiveError('扩展头无效')
    const length = Number(data.subarray(offset, space).toString('latin1'))
    if (!Number.isSafeInteger(length) || length <= space - offset + 1 || offset + length > data.length || data[offset + length - 1] !== 0x0a) {
      throw new AntigravityCliArchiveError('扩展头无效')
    }
    const record = data.subarray(space + 1, offset + length - 1).toString('utf8')
    const equals = record.indexOf('=')
    if (equals < 0) throw new AntigravityCliArchiveError('扩展头无效')
    const key = record.slice(0, equals)
    if (key === 'path') path = record.slice(equals + 1)
    else if (key === 'size' || key === 'linkpath') throw new AntigravityCliArchiveError('扩展头里有不认识的设置')
    offset += length
  }
  return path
}

type EntryKind = 'file' | 'skip-directory' | 'pax' | 'pax-global'

function classifyEntry(header: Buffer, name: string): EntryKind {
  const type = String.fromCharCode(header[156])
  if (type === '0' || type === '\0') return 'file'
  if (type === 'x') return 'pax'
  if (type === 'g') return 'pax-global'
  // `tar -C dir .` records the folder itself first; that is the destination, not an entry of ours.
  if (type === '5' && (name === '.' || name === './' || name === '')) return 'skip-directory'
  throw new AntigravityCliArchiveError(`里面有链接、文件夹或其他特殊条目（类型 ${JSON.stringify(type)}）`)
}

/**
 * Unpacks the one `antigravity` executable from Google's archive into `destination`, which must
 * not exist yet (it is created exclusively, 0600; the installer sets the final mode). Returns its
 * size. AppleDouble `._antigravity` metadata, which a Mac's own tar adds, is skipped.
 */
export async function extractAntigravityCliArchive(
  archivePath: string,
  destination: string,
  maximumBytes: number = maximumAntigravityCliExecutableBytes,
): Promise<number> {
  const output = await fs.promises.open(destination, 'wx', 0o600)
  let pending = Buffer.alloc(0)
  let headerBlocks = 0
  let paxPath: string | null = null
  let written: number | null = null
  // The entry being read: how many data bytes are left, whether they go to the file, and how much
  // block padding follows them.
  let remaining = 0
  let padding = 0
  let target: 'file' | 'skip' | 'pax' | null = null
  let paxData: Buffer[] = []
  let finished = false
  let fileBytes = 0
  let completed = false
  try {
    const gunzip = fs.createReadStream(archivePath).pipe(zlib.createGunzip())
    for await (const chunk of gunzip as AsyncIterable<Buffer>) {
      if (finished) {
        // Everything after the end-of-archive block is the zero padding tar writes to fill its record.
        if (chunk.some((byte) => byte !== 0)) throw new AntigravityCliArchiveError('结尾后面还有内容')
        continue
      }
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
      while (!finished) {
        if (target !== null) {
          if (remaining > 0) {
            if (pending.length === 0) break
            const take = Math.min(remaining, pending.length)
            const slice = pending.subarray(0, take)
            if (target === 'file') {
              await output.write(slice)
              fileBytes += take
            } else if (target === 'pax') {
              paxData.push(Buffer.from(slice))
            }
            remaining -= take
            pending = pending.subarray(take)
            continue
          }
          if (pending.length < padding) break
          pending = pending.subarray(padding)
          padding = 0
          if (target === 'file') written = fileBytes
          if (target === 'pax') paxPath = readPaxPath(Buffer.concat(paxData))
          target = null
          continue
        }
        if (pending.length < blockBytes) break
        const header = pending.subarray(0, blockBytes)
        pending = pending.subarray(blockBytes)
        if (header.every((byte) => byte === 0)) {
          finished = true
          if (pending.some((byte) => byte !== 0)) throw new AntigravityCliArchiveError('结尾后面还有内容')
          break
        }
        headerBlocks += 1
        if (headerBlocks > maximumHeaderBlocks) throw new AntigravityCliArchiveError('条目太多')
        if (!headerChecksumMatches(header)) throw new AntigravityCliArchiveError('条目头校验不通过')
        if (!header.subarray(257, 262).equals(Buffer.from('ustar'))) throw new AntigravityCliArchiveError('不是 tar 格式')
        const size = readOctal(header.subarray(124, 136))
        if (size === null) throw new AntigravityCliArchiveError('条目大小无效')
        const rawName = entryName(header)
        const kind = classifyEntry(header, rawName)
        const name = normalizedName(kind === 'file' && paxPath !== null ? paxPath : rawName)
        if (kind !== 'pax') paxPath = null
        remaining = size
        padding = (blockBytes - (size % blockBytes)) % blockBytes
        if (kind === 'file') {
          if (name === `._${archiveExecutableName}`) {
            if (size > 1024 * 1024) throw new AntigravityCliArchiveError('附带的文件信息太大')
            target = 'skip'
          } else if (name !== archiveExecutableName) {
            throw new AntigravityCliArchiveError(`里面有 ${archiveExecutableName} 以外的文件`)
          } else if (written !== null || fileBytes > 0) {
            throw new AntigravityCliArchiveError(`里面有两个 ${archiveExecutableName}`)
          } else if (size > maximumBytes) {
            throw new AntigravityCliArchiveError('程序太大')
          } else {
            target = 'file'
          }
        } else if (kind === 'pax') {
          if (size > 64 * 1024) throw new AntigravityCliArchiveError('扩展头太大')
          paxData = []
          target = 'pax'
        } else {
          if (kind === 'skip-directory' && size !== 0) throw new AntigravityCliArchiveError('条目大小无效')
          if (size > 64 * 1024) throw new AntigravityCliArchiveError('扩展头太大')
          target = 'skip'
        }
      }
    }
    if (!finished || target !== null) throw new AntigravityCliArchiveError('安装包不完整')
    if (written === null || written === 0) throw new AntigravityCliArchiveError(`里面没有 ${archiveExecutableName}`)
    await output.sync()
    completed = true
    return written
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code === 'Z_DATA_ERROR' || code === 'Z_BUF_ERROR') throw new AntigravityCliArchiveError('解压失败')
    throw error
  } finally {
    await output.close().catch(() => undefined)
    if (!completed) await fs.promises.rm(destination, { force: true }).catch(() => undefined)
  }
}

export type MachOArchitecture = 'arm64' | 'x86_64'

const cpuTypes: Record<number, MachOArchitecture> = { 0x0100000c: 'arm64', 0x01000007: 'x86_64' }

/** The processors a Mach-O header names, read from its first bytes; empty when it is not one. */
export function readMachOArchitectures(header: Buffer): MachOArchitecture[] {
  if (header.length < 8) return []
  const thinMagic = header.readUInt32LE(0)
  if (thinMagic === 0xfeedfacf) {
    const architecture = cpuTypes[header.readUInt32LE(4)]
    return architecture ? [architecture] : []
  }
  const fatMagic = header.readUInt32BE(0)
  if (fatMagic !== 0xcafebabe && fatMagic !== 0xcafebabf) return []
  const count = header.readUInt32BE(4)
  const entryBytes = fatMagic === 0xcafebabe ? 20 : 32
  if (count === 0 || count > 8 || header.length < 8 + count * entryBytes) return []
  const found: MachOArchitecture[] = []
  for (let index = 0; index < count; index += 1) {
    const architecture = cpuTypes[header.readUInt32BE(8 + index * entryBytes)]
    if (architecture && !found.includes(architecture)) found.push(architecture)
  }
  return found
}

export interface AntigravityCliDarwinProcess {
  executable: string
  argv: string[]
  timeoutMs: number
}

/**
 * Accepts the unpacked executable only when it is Google's Developer ID build of agy for this
 * Mac's processor. A refusal by codesign is a DarwinCliProvenanceError (somebody else's build);
 * codesign failing to run at all is passed on as it is.
 */
export async function verifyDarwinAntigravityCli(
  executablePath: string,
  architecture: 'x64' | 'arm64',
  runProcess: (plan: AntigravityCliDarwinProcess) => Promise<CommandResult>,
): Promise<void> {
  const handle = await fs.promises.open(executablePath, 'r')
  let header: Buffer
  try {
    header = Buffer.alloc(8 + 8 * 32)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    header = header.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
  const wanted: MachOArchitecture = architecture === 'arm64' ? 'arm64' : 'x86_64'
  if (!readMachOArchitectures(header).includes(wanted)) {
    throw new DarwinCliProvenanceError('下载的 Antigravity 命令行与这台 Mac 的处理器不匹配，未进行安装')
  }
  try {
    await runProcess({
      executable: '/usr/bin/codesign',
      argv: darwinDeveloperIdVerificationArgv(antigravityCliTeamIdentifier, executablePath, { bundleIdentifier: antigravityCliCodeIdentifier }),
      timeoutMs: codesignTimeoutMs,
    })
  } catch (error) {
    if (error instanceof CommandRunnerError && error.code === 'EXIT_NON_ZERO') {
      throw new DarwinCliProvenanceError('下载的 Antigravity 命令行不是 Google 官方签名版本，已删除，未进行安装', { cause: error })
    }
    throw error
  }
}

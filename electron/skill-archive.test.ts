import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SKILL_ARCHIVE_MANY_SKILLS,
  SKILL_ARCHIVE_NO_SKILL,
  SKILL_ARCHIVE_TOO_LARGE,
  SKILL_ARCHIVE_UNREADABLE,
  SKILL_ARCHIVE_UNSAFE,
  buildSkillArchivePlan,
  discardSkillArchiveExtractions,
  extractSkillArchive,
  readSkillArchiveEntries,
} from './skill-archive'

interface TestEntry {
  name: string | Buffer
  data?: string | Buffer
  method?: 0 | 8
  flags?: number
  hostSystem?: number
  externalAttributes?: number
  /** Overrides the size written in the central directory (to fake a bomb or a lie). */
  declaredSize?: number
  crc32?: number
}

function buildZip(entries: readonly TestEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = typeof entry.name === 'string' ? Buffer.from(entry.name, 'utf8') : entry.name
    const data = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : entry.data ?? Buffer.alloc(0)
    const method = entry.method ?? 8
    const packed = method === 8 ? zlib.deflateRawSync(data) : data
    const crc = entry.crc32 ?? zlib.crc32(data)
    const size = entry.declaredSize ?? data.length
    const flags = entry.flags ?? (typeof entry.name === 'string' ? 0x0800 : 0)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, packed)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt8(20, 4)
    central.writeUInt8(entry.hostSystem ?? 0, 5)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(packed.length, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(entry.externalAttributes ?? 0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += local.length + name.length + packed.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

const skillText = '---\nname: pdf-helper\ndescription: Reads PDFs.\n---\nUse it.\n'

const temporaryRoots: string[] = []

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-skill-archive-'))
  temporaryRoots.push(root)
  return root
}

function writeArchive(root: string, name: string, archive: Buffer): string {
  const archivePath = path.join(root, name)
  fs.writeFileSync(archivePath, archive)
  return archivePath
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('skill-archive', () => {
  it('extracts the folder holding SKILL.md and leaves the rest of the archive behind', async () => {
    const root = temporaryRoot()
    const archivePath = writeArchive(root, 'downloads.zip', buildZip([
      { name: 'README.md', data: 'outside the skill' },
      { name: 'pdf-helper/', hostSystem: 3, externalAttributes: (0o040755 << 16) >>> 0 },
      { name: 'pdf-helper/SKILL.md', data: skillText, hostSystem: 3, externalAttributes: (0o100644 << 16) >>> 0 },
      { name: 'pdf-helper/scripts/run.py', data: 'print(1)\n', method: 0 },
      { name: '__MACOSX/pdf-helper/._SKILL.md', data: 'resource fork' },
      { name: 'pdf-helper/.DS_Store', data: 'finder' },
    ]))
    const base = path.join(root, 'extracted')

    const extraction = await extractSkillArchive(archivePath, base)

    expect(extraction.archiveName).toBe('downloads.zip')
    expect(path.basename(extraction.directory)).toBe('pdf-helper')
    expect(extraction.directory.startsWith(base + path.sep)).toBe(true)
    expect(fs.readFileSync(path.join(extraction.directory, 'SKILL.md'), 'utf8')).toBe(skillText)
    expect(fs.readFileSync(path.join(extraction.directory, 'scripts', 'run.py'), 'utf8')).toBe('print(1)\n')
    expect(fs.readdirSync(extraction.directory).sort()).toEqual(['SKILL.md', 'scripts'])
    expect(fs.existsSync(path.join(path.dirname(extraction.directory), 'README.md'))).toBe(false)
  })

  it('names a skill packed at the top of the archive after the archive file', async () => {
    const root = temporaryRoot()
    const archivePath = writeArchive(root, '写作助手.zip', buildZip([
      { name: 'SKILL.md', data: skillText },
      { name: 'notes/写法.md', data: '短一点' },
    ]))

    const extraction = await extractSkillArchive(archivePath, path.join(root, 'extracted'))

    expect(path.basename(extraction.directory)).toBe('写作助手')
    expect(fs.readFileSync(path.join(extraction.directory, 'notes', '写法.md'), 'utf8')).toBe('短一点')
  })

  it('keeps only the latest extraction', async () => {
    const root = temporaryRoot()
    const base = path.join(root, 'extracted')
    const first = await extractSkillArchive(writeArchive(root, 'a.zip', buildZip([{ name: 'a/SKILL.md', data: skillText }])), base)
    const second = await extractSkillArchive(writeArchive(root, 'b.zip', buildZip([{ name: 'b/SKILL.md', data: skillText }])), base)

    expect(fs.existsSync(first.directory)).toBe(false)
    expect(fs.existsSync(second.directory)).toBe(true)
    expect(fs.readdirSync(base)).toHaveLength(1)
  })

  it('discards every unpacked copy once the import form is done and leaves files it did not name alone', async () => {
    const root = temporaryRoot()
    const base = path.join(root, 'extracted')
    const extraction = await extractSkillArchive(writeArchive(root, 'a.zip', buildZip([{ name: 'a/SKILL.md', data: skillText }])), base)
    fs.writeFileSync(path.join(base, 'not-ours.txt'), 'keep')

    await discardSkillArchiveExtractions(base)

    expect(fs.existsSync(extraction.directory)).toBe(false)
    expect(fs.readdirSync(base)).toEqual(['not-ours.txt'])
  })

  it('creates nothing when there was never anything unpacked', async () => {
    const root = temporaryRoot()
    const base = path.join(root, 'extracted')

    await discardSkillArchiveExtractions(base)

    expect(fs.existsSync(base)).toBe(false)
  })

  it('waits for an unpack already under way, so the copy it makes is not left behind', async () => {
    const root = temporaryRoot()
    const base = path.join(root, 'extracted')
    const unpacking = extractSkillArchive(writeArchive(root, 'a.zip', buildZip([{ name: 'a/SKILL.md', data: skillText }])), base)
    const discarding = discardSkillArchiveExtractions(base)

    const extraction = await unpacking
    await discarding

    expect(fs.existsSync(extraction.directory)).toBe(false)
    expect(fs.readdirSync(base)).toEqual([])
  })

  it('still discards after an unpack that failed', async () => {
    const root = temporaryRoot()
    const base = path.join(root, 'extracted')
    const earlier = await extractSkillArchive(writeArchive(root, 'a.zip', buildZip([{ name: 'a/SKILL.md', data: skillText }])), base)
    const failing = extractSkillArchive(writeArchive(root, 'broken.zip', Buffer.from('not a zip at all')), base)
    const discarding = discardSkillArchiveExtractions(base)

    await expect(failing).rejects.toThrow(SKILL_ARCHIVE_UNREADABLE)
    await expect(discarding).resolves.toBeUndefined()
    expect(fs.existsSync(earlier.directory)).toBe(false)
  })

  it('refuses to clean through a temporary folder that was swapped for a link', async () => {
    const root = temporaryRoot()
    const elsewhere = path.join(root, 'elsewhere')
    const bystander = path.join(elsewhere, '0b5f7c8e-1d2a-4c3b-9e8f-7a6b5c4d3e2f')
    fs.mkdirSync(bystander, { recursive: true })
    const base = path.join(root, 'extracted')
    try {
      fs.symlinkSync(elsewhere, base, 'junction')
    } catch {
      return
    }

    await expect(discardSkillArchiveExtractions(base)).rejects.toThrow()
    expect(fs.existsSync(bystander)).toBe(true)
  })

  it('picks the shallowest SKILL.md and treats deeper ones as part of that skill', () => {
    const plan = buildSkillArchivePlan(readSkillArchiveEntries(buildZip([
      { name: 'repo-main/SKILL.md', data: skillText },
      { name: 'repo-main/examples/inner/SKILL.md', data: skillText },
    ])), 'repo-main.zip')

    expect(plan.folderName).toBe('repo-main')
    expect(plan.entries.map((entry) => entry.path).sort()).toEqual(['SKILL.md', 'examples/inner/SKILL.md'])
  })

  it('refuses to pick between two skills at the same depth', () => {
    const entries = readSkillArchiveEntries(buildZip([
      { name: 'skills/a/SKILL.md', data: skillText },
      { name: 'skills/b/SKILL.md', data: skillText },
    ]))
    expect(() => buildSkillArchivePlan(entries, 'skills.zip')).toThrow(SKILL_ARCHIVE_MANY_SKILLS)
  })

  it('says so when there is no SKILL.md, matching the name exactly', () => {
    const entries = readSkillArchiveEntries(buildZip([{ name: 'thing/skill.MD', data: skillText }]))
    expect(() => buildSkillArchivePlan(entries, 'thing.zip')).toThrow(SKILL_ARCHIVE_NO_SKILL)
  })

  it.each([
    ['a parent directory hop', '../evil/SKILL.md'],
    ['a hop in the middle', 'skill/../../SKILL.md'],
    ['an absolute path', '/etc/SKILL.md'],
    ['a Windows drive', 'C:/Users/SKILL.md'],
    ['backslash hops', 'skill\\..\\..\\SKILL.md'],
    ['a Windows device name', 'skill/CON/SKILL.md'],
    ['a trailing dot Windows would drop', 'skill./SKILL.md'],
    ['a reserved character', 'skill/a:b/SKILL.md'],
    ['a control character', 'skill/\u0001/SKILL.md'],
  ])('refuses %s', (_label, name) => {
    expect(() => readSkillArchiveEntries(buildZip([{ name, data: skillText }]))).toThrow(SKILL_ARCHIVE_UNSAFE)
  })

  it('refuses symlinks and other special files recorded by Unix zip tools', () => {
    const symlink = (0o120777 << 16) >>> 0
    const fifo = (0o010644 << 16) >>> 0
    expect(() => readSkillArchiveEntries(buildZip([
      { name: 'skill/SKILL.md', data: skillText },
      { name: 'skill/link', data: '/etc/passwd', method: 0, hostSystem: 3, externalAttributes: symlink },
    ]))).toThrow(SKILL_ARCHIVE_UNSAFE)
    expect(() => readSkillArchiveEntries(buildZip([
      { name: 'skill/pipe', hostSystem: 3, externalAttributes: fifo },
    ]))).toThrow(SKILL_ARCHIVE_UNSAFE)
  })

  it('refuses names that collide once case is folded, and a file standing where a folder goes', () => {
    expect(() => readSkillArchiveEntries(buildZip([
      { name: 'skill/SKILL.md', data: skillText },
      { name: 'skill/skill.md', data: 'other' },
    ]))).toThrow(SKILL_ARCHIVE_UNSAFE)
    expect(() => readSkillArchiveEntries(buildZip([
      { name: 'skill/scripts', data: 'a file' },
      { name: 'skill/scripts/run.py', data: 'print(1)' },
    ]))).toThrow(SKILL_ARCHIVE_UNSAFE)
    expect(() => readSkillArchiveEntries(buildZip([
      { name: 'skill/scripts/run.py', data: 'print(1)' },
      { name: 'skill/scripts', data: 'a file' },
    ]))).toThrow(SKILL_ARCHIVE_UNSAFE)
  })

  it('refuses encrypted entries, unknown methods and archives that are not zip files', () => {
    expect(() => readSkillArchiveEntries(buildZip([{ name: 'skill/SKILL.md', data: skillText, flags: 0x0801 }]))).toThrow(SKILL_ARCHIVE_UNREADABLE)
    const unknownMethod = buildZip([{ name: 'skill/SKILL.md', data: skillText, method: 0 }])
    // Rewrite the central directory's method field to bzip2 (12).
    const centralOffset = unknownMethod.readUInt32LE(unknownMethod.length - 22 + 16)
    unknownMethod.writeUInt16LE(12, centralOffset + 10)
    expect(() => readSkillArchiveEntries(unknownMethod)).toThrow(SKILL_ARCHIVE_UNREADABLE)
    expect(() => readSkillArchiveEntries(Buffer.from('not a zip at all, just text'))).toThrow(SKILL_ARCHIVE_UNREADABLE)
    expect(() => readSkillArchiveEntries(Buffer.alloc(4))).toThrow(SKILL_ARCHIVE_UNREADABLE)
  })

  it('refuses archives over the file count or the unpacked size before inflating anything', () => {
    const many = Array.from({ length: 2_001 }, (_, index) => ({ name: `skill/f${index}.txt`, data: '', method: 0 as const }))
    expect(() => readSkillArchiveEntries(buildZip(many))).toThrow(SKILL_ARCHIVE_TOO_LARGE)
    expect(() => readSkillArchiveEntries(buildZip([
      { name: 'skill/SKILL.md', data: skillText },
      { name: 'skill/big.bin', data: 'x', declaredSize: 51 * 1024 * 1024 },
    ]))).toThrow(SKILL_ARCHIVE_TOO_LARGE)
  })

  it('refuses an archive file over 50 MB without reading it', async () => {
    const root = temporaryRoot()
    const archivePath = path.join(root, 'huge.zip')
    fs.writeFileSync(archivePath, '')
    fs.truncateSync(archivePath, 50 * 1024 * 1024 + 1)
    await expect(extractSkillArchive(archivePath, path.join(root, 'extracted'))).rejects.toThrow(SKILL_ARCHIVE_TOO_LARGE)
  })

  it('stops an entry that inflates past its declared size and cleans up what it wrote', async () => {
    const root = temporaryRoot()
    const base = path.join(root, 'extracted')
    const bomb = Buffer.alloc(1024 * 1024, 0)
    const archivePath = writeArchive(root, 'bomb.zip', buildZip([
      { name: 'skill/SKILL.md', data: skillText },
      { name: 'skill/zeros.bin', data: bomb, declaredSize: 10, crc32: zlib.crc32(bomb.subarray(0, 10)) },
    ]))

    await expect(extractSkillArchive(archivePath, base)).rejects.toThrow(SKILL_ARCHIVE_UNREADABLE)
    expect(fs.readdirSync(base)).toEqual([])
  })

  it('refuses an entry whose content does not match its checksum', async () => {
    const root = temporaryRoot()
    const archivePath = writeArchive(root, 'bad.zip', buildZip([{ name: 'skill/SKILL.md', data: skillText, crc32: 1 }]))
    await expect(extractSkillArchive(archivePath, path.join(root, 'extracted'))).rejects.toThrow(SKILL_ARCHIVE_UNREADABLE)
  })

  it('reads GBK names that Windows writes without the UTF-8 flag', () => {
    // 「技能」in GBK.
    const gbk = Buffer.concat([Buffer.from('skill/', 'latin1'), Buffer.from([0xbc, 0xbc, 0xc4, 0xdc]), Buffer.from('.md', 'latin1')])
    const entries = readSkillArchiveEntries(buildZip([
      { name: 'skill/SKILL.md', data: skillText },
      { name: gbk, data: 'x' },
    ]))
    expect(entries.map((entry) => entry.path)).toContain('skill/技能.md')
  })

  it('refuses an archive that is a symlink', async () => {
    const root = temporaryRoot()
    const real = writeArchive(root, 'real.zip', buildZip([{ name: 'skill/SKILL.md', data: skillText }]))
    const link = path.join(root, 'link.zip')
    try {
      fs.symlinkSync(real, link)
    } catch {
      return
    }
    await expect(extractSkillArchive(link, path.join(root, 'extracted'))).rejects.toThrow()
  })

  describe('skill archive entries with random inputs', () => {
    it('never yields a path that leaves the folder, whatever the entry names are', () => {
      const segment = fc.oneof(
        fc.constantFrom('..', '.', '', 'SKILL.md', 'a', 'C:', '\\..', '..\\', '/', 'CON', 'x.', 'a:b'),
        fc.string({ maxLength: 8 }),
      )
      const name = fc
        .tuple(fc.array(segment, { minLength: 1, maxLength: 6 }), fc.constantFrom('/', '\\'))
        .map(([parts, separator]) => parts.join(separator))
      fc.assert(fc.property(fc.array(name, { minLength: 1, maxLength: 6 }), (names) => {
        let entries
        try {
          entries = readSkillArchiveEntries(buildZip(names.map((entryName) => ({ name: entryName, data: 'x' }))))
        } catch (error) {
          expect([SKILL_ARCHIVE_UNSAFE, SKILL_ARCHIVE_UNREADABLE, SKILL_ARCHIVE_TOO_LARGE]).toContain((error as Error).message)
          return
        }
        for (const entry of entries) {
          const resolved = path.posix.resolve('/root', entry.path)
          expect(resolved.startsWith('/root/')).toBe(true)
          expect(entry.path.split('/')).not.toContain('..')
          expect(entry.path.includes('\\')).toBe(false)
        }
      }), { numRuns: 300 })
    })
  })
})

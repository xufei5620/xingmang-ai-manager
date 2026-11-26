import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SKILL_IMPORT_CHANGED_MESSAGE,
  copySkillSnapshot,
  createSkillImportStaging,
  discardSkillImportStaging,
  isLiveSkillImportStaging,
  isSkillImportStagingName,
  releaseSkillImportStaging,
  snapshotSkillTree,
  type SkillTreeLimits,
} from './skill-import-snapshot'

const temporaryDirectories: string[] = []
const limits: SkillTreeLimits = { files: 2_000, bytes: 50 * 1024 * 1024, entries: 10_000, depth: 32 }
const directoryLink = process.platform === 'win32' ? 'junction' : 'dir'

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-skill-snapshot-test-'))
  temporaryDirectories.push(directory)
  return directory
}

function write(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, 'utf8')
}

function listTree(root: string): Record<string, string> {
  const result: Record<string, string> = {}
  const pending = ['']
  while (pending.length) {
    const relative = pending.pop()!
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        result[`${child}/`] = ''
        pending.push(child)
      } else {
        result[child] = fs.readFileSync(path.join(root, child), 'utf8')
      }
    }
  }
  return result
}

function skillSource(name = 'sample-skill'): string {
  const source = path.join(temporaryDirectory(), name)
  write(path.join(source, 'SKILL.md'), '---\nname: Sample\n---\n')
  write(path.join(source, 'scripts', 'deep', 'run.txt'), 'resource-content')
  write(path.join(source, '参考', '范文.md'), '范文内容')
  fs.mkdirSync(path.join(source, 'empty'))
  return source
}

function stagingFor(): { root: string; staging: ReturnType<typeof createSkillImportStaging> } {
  const root = path.join(temporaryDirectory(), 'skills')
  return { root, staging: createSkillImportStaging(root) }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('skill import snapshot', () => {
  it('copies exactly the snapshotted tree, byte for byte', () => {
    const source = skillSource()
    const before = listTree(source)
    const snapshot = snapshotSkillTree(source, limits)
    const { staging } = stagingFor()

    copySkillSnapshot(snapshot, staging.directory, limits)

    expect(listTree(staging.directory)).toEqual(before)
    expect(listTree(source)).toEqual(before)
    expect(snapshot.entries[0]).toMatchObject({ segments: [], kind: 'directory' })
  })

  it('stops when a subfolder is swapped for a link to an outside folder after the snapshot', () => {
    const source = skillSource()
    const outside = temporaryDirectory()
    write(path.join(outside, 'deep', 'run.txt'), 'OUTSIDE-MARKER')
    const snapshot = snapshotSkillTree(source, limits)
    fs.renameSync(path.join(source, 'scripts'), path.join(path.dirname(source), 'scripts-away'))
    fs.symlinkSync(outside, path.join(source, 'scripts'), directoryLink)
    const { root, staging } = stagingFor()

    expect(() => copySkillSnapshot(snapshot, staging.directory, limits)).toThrow(SKILL_IMPORT_CHANGED_MESSAGE)
    discardSkillImportStaging(staging)

    expect(fs.readdirSync(root)).toEqual([])
    expect(fs.readFileSync(path.join(outside, 'deep', 'run.txt'), 'utf8')).toBe('OUTSIDE-MARKER')
  })

  it('stops when a folder deeper down is swapped while files are being copied', () => {
    const source = skillSource()
    const outside = temporaryDirectory()
    write(path.join(outside, 'run.txt'), 'OUTSIDE-MARKER')
    const snapshot = snapshotSkillTree(source, limits)
    const { staging } = stagingFor()
    const copied: string[] = []

    expect(() => copySkillSnapshot(snapshot, staging.directory, limits, {
      beforeOpen(relativePath) {
        copied.push(relativePath)
        if (relativePath !== 'scripts/deep/run.txt') return
        fs.renameSync(path.join(source, 'scripts', 'deep'), path.join(path.dirname(source), 'deep-away'))
        fs.symlinkSync(outside, path.join(source, 'scripts', 'deep'), directoryLink)
      },
    })).toThrow(SKILL_IMPORT_CHANGED_MESSAGE)

    expect(copied).toContain('scripts/deep/run.txt')
    expect(fs.existsSync(path.join(staging.directory, 'scripts', 'deep', 'run.txt'))).toBe(false)
  })

  it('stops when the skill folder itself is swapped after the snapshot', () => {
    const source = skillSource()
    const outside = temporaryDirectory()
    write(path.join(outside, 'SKILL.md'), '---\nname: Sample\n---\n')
    write(path.join(outside, 'secret.txt'), 'OUTSIDE-SECRET')
    const snapshot = snapshotSkillTree(source, limits)
    fs.renameSync(source, `${source}-away`)
    fs.symlinkSync(outside, source, directoryLink)
    const { staging } = stagingFor()

    expect(() => copySkillSnapshot(snapshot, staging.directory, limits)).toThrow(SKILL_IMPORT_CHANGED_MESSAGE)
    expect(fs.readdirSync(staging.directory)).toEqual([])
  })

  it('stops when a file is replaced by a new one of the same name and size', () => {
    const source = skillSource()
    const snapshot = snapshotSkillTree(source, limits)
    const file = path.join(source, 'scripts', 'deep', 'run.txt')
    const replacement = path.join(source, 'replacement.tmp')
    fs.writeFileSync(replacement, 'RESOURCE-CONTENT', 'utf8')
    fs.renameSync(replacement, file)
    const { staging } = stagingFor()

    expect(() => copySkillSnapshot(snapshot, staging.directory, limits)).toThrow(SKILL_IMPORT_CHANGED_MESSAGE)
  })

  it('stops when a listed file disappears or turns into a folder', () => {
    const source = skillSource()
    const snapshot = snapshotSkillTree(source, limits)
    fs.rmSync(path.join(source, 'scripts', 'deep', 'run.txt'))
    fs.mkdirSync(path.join(source, 'scripts', 'deep', 'run.txt'))
    const { staging } = stagingFor()

    expect(() => copySkillSnapshot(snapshot, staging.directory, limits)).toThrow(SKILL_IMPORT_CHANGED_MESSAGE)
  })

  it('does not copy a file that appears after the snapshot', () => {
    const source = skillSource()
    const snapshot = snapshotSkillTree(source, limits)
    write(path.join(source, 'scripts', 'late.txt'), 'LATE')
    const { staging } = stagingFor()

    copySkillSnapshot(snapshot, staging.directory, limits)

    expect(fs.existsSync(path.join(staging.directory, 'scripts', 'late.txt'))).toBe(false)
    expect(fs.readFileSync(path.join(staging.directory, 'scripts', 'deep', 'run.txt'), 'utf8')).toBe('resource-content')
  })

  it('refuses hard links, symbolic links and a missing definition while taking the snapshot', () => {
    const linked = skillSource('linked')
    const outside = path.join(temporaryDirectory(), 'outside.txt')
    write(outside, 'OUTSIDE-MARKER')
    fs.linkSync(outside, path.join(linked, 'resource.txt'))
    expect(() => snapshotSkillTree(linked, limits)).toThrow('硬链接')

    const symbolic = skillSource('symbolic')
    fs.symlinkSync(temporaryDirectory(), path.join(symbolic, 'elsewhere'), directoryLink)
    expect(() => snapshotSkillTree(symbolic, limits)).toThrow('符号链接')

    const bare = path.join(temporaryDirectory(), 'bare')
    write(path.join(bare, 'README.md'), 'no definition')
    expect(() => snapshotSkillTree(bare, limits)).toThrow('Skill 目录根部缺少 SKILL.md')
  })

  it('refuses a file that gained a hard link after the snapshot', () => {
    const source = skillSource()
    const snapshot = snapshotSkillTree(source, limits)
    fs.linkSync(path.join(source, 'scripts', 'deep', 'run.txt'), path.join(temporaryDirectory(), 'extra-link.txt'))
    const { staging } = stagingFor()

    expect(() => copySkillSnapshot(snapshot, staging.directory, limits)).toThrow('硬链接')
  })

  it('keeps the size, count and depth limits of the snapshot', () => {
    const source = skillSource()
    expect(() => snapshotSkillTree(source, { ...limits, files: 2 })).toThrow('超过安全限制')
    expect(() => snapshotSkillTree(source, { ...limits, bytes: 10 })).toThrow('超过安全限制')
    expect(() => snapshotSkillTree(source, { ...limits, depth: 2 })).toThrow('层级超过安全限制')
    expect(() => snapshotSkillTree(source, { ...limits, entries: 3 })).toThrow('条目超过安全上限')
  })

  it('removes only the staging folder it created', () => {
    const { root, staging } = stagingFor()
    write(path.join(staging.directory, 'partial.txt'), 'partial')
    fs.mkdirSync(path.join(root, 'kept-skill'))

    discardSkillImportStaging(staging)

    expect(fs.readdirSync(root)).toEqual(['kept-skill'])

    // A staging path that now names another folder is left alone.
    const second = createSkillImportStaging(root)
    fs.renameSync(second.directory, path.join(root, 'moved-away'))
    fs.mkdirSync(second.directory)
    write(path.join(second.directory, 'keep.txt'), 'keep')
    discardSkillImportStaging(second)
    expect(fs.readFileSync(path.join(second.directory, 'keep.txt'), 'utf8')).toBe('keep')
  })

  // Discarding runs inside the import's catch block: a folder that cannot be
  // removed must not replace the error the customer needs to see.
  it('does not throw when the staging folder cannot be removed', () => {
    const { staging } = stagingFor()
    write(path.join(staging.directory, 'SKILL.md'), '---\nname: Held\n---\n')
    const spy = vi.spyOn(fs, 'rmSync').mockImplementation(() => {
      throw Object.assign(new Error('EBUSY: resource busy or locked, rmdir'), { code: 'EBUSY' })
    })

    expect(() => discardSkillImportStaging(staging)).not.toThrow()
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()

    expect(fs.existsSync(path.join(staging.directory, 'SKILL.md'))).toBe(true)
    // What is left is now a leftover for the sweep, no longer owned by an import.
    expect(isLiveSkillImportStaging(staging.directory)).toBe(false)
  })

  it('names staging folders so that only they are recognised, and tracks the ones still in use', () => {
    const { staging } = stagingFor()
    expect(isSkillImportStagingName(path.basename(staging.directory))).toBe(true)
    for (const name of [
      '.xingmang-import-',
      '.xingmang-import-notes',
      'xingmang-import-0b6f3c2e-4a1d-4c8e-9f00-123456789abc',
      '.xingmang-import-0B6F3C2E-4A1D-4C8E-9F00-123456789ABC',
      '.xingmang-import-0b6f3c2e-4a1d-4c8e-9f00-123456789abc-copy',
      'my-skill',
    ]) {
      expect(isSkillImportStagingName(name)).toBe(false)
    }

    expect(isLiveSkillImportStaging(staging.directory)).toBe(true)
    releaseSkillImportStaging(staging)
    expect(isLiveSkillImportStaging(staging.directory)).toBe(false)

    const discarded = createSkillImportStaging(path.dirname(staging.directory))
    expect(isLiveSkillImportStaging(discarded.directory)).toBe(true)
    discardSkillImportStaging(discarded)
    expect(isLiveSkillImportStaging(discarded.directory)).toBe(false)
  })
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  captureUninstallLeftovers,
  removeUninstallLeftovers,
  type UninstallLeftoverOptions,
} from './uninstall-leftovers'

const temporaryDirectories: string[] = []
const posixHost = process.platform !== 'win32'

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function temporaryDirectory(): string {
  // realpath: macOS hands out /var/... temp paths that resolve through /private.
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-uninstall-leftovers-')))
  temporaryDirectories.push(directory)
  return directory
}

function exists(filePath: string): boolean {
  try {
    fs.lstatSync(filePath)
    return true
  } catch {
    return false
  }
}

function hostOptions(overrides: Partial<UninstallLeftoverOptions> = {}): UninstallLeftoverOptions {
  return {
    platform: process.platform,
    ownerUid: process.platform === 'win32' ? undefined : process.getuid?.(),
    ...overrides,
  }
}

/** What an uninstall that could not finish leaves in ~/.grok/bin: a program file and, on POSIX, a renamed link. */
function leftoverDirectory() {
  const root = temporaryDirectory()
  const bin = path.join(root, '.grok', 'bin')
  fs.mkdirSync(bin, { recursive: true })
  const program = path.join(bin, 'grok-1.0.46')
  fs.writeFileSync(program, 'grok binary', { mode: 0o755 })
  const neighbour = path.join(bin, 'keep.txt')
  fs.writeFileSync(neighbour, 'keep')
  const quarantine = path.join(bin, '.grok-6f1c2f0e-5d8b-4c1a-9f3e-2b7d4c9a1e00.removing')
  return { root, bin, program, neighbour, quarantine }
}

describe('captureUninstallLeftovers', () => {
  it.runIf(posixHost)('pins regular files and links in a plain directory and drops paths already gone', () => {
    const layout = leftoverDirectory()
    fs.symlinkSync('grok-1.0.46', layout.quarantine)

    const leftovers = captureUninstallLeftovers([
      layout.program,
      layout.quarantine,
      path.join(layout.bin, 'grok-1.0.45'),
      path.join(layout.bin, 'missing-directory', 'grok-1.0.44'),
      layout.program,
      'relative/grok-1.0.43',
    ], hostOptions())

    expect(leftovers).toEqual([
      expect.objectContaining({ kind: 'pinned', path: layout.program, directory: layout.bin, linkTarget: null }),
      expect.objectContaining({ kind: 'pinned', path: layout.quarantine, directory: layout.bin, linkTarget: 'grok-1.0.46' }),
    ])
  })

  it('never pins a hard-linked file or a directory', () => {
    const layout = leftoverDirectory()
    const hardLinked = path.join(layout.bin, 'grok-1.0.45')
    fs.writeFileSync(hardLinked, 'old grok')
    fs.linkSync(hardLinked, path.join(layout.root, 'elsewhere'))
    const directory = path.join(layout.bin, 'grok-1.0.44')
    fs.mkdirSync(directory)

    expect(captureUninstallLeftovers([hardLinked, directory], hostOptions())).toEqual([
      { kind: 'unverifiable', path: hardLinked },
      { kind: 'unverifiable', path: directory },
    ])
  })

  it.runIf(posixHost)('never pins anything another account owns, others can write to, or a link on Windows', () => {
    const layout = leftoverDirectory()
    fs.symlinkSync('grok-1.0.46', layout.quarantine)
    const otherOwner = (process.getuid?.() ?? 0) + 1

    expect(captureUninstallLeftovers([layout.program], hostOptions({ ownerUid: otherOwner }))).toEqual([
      { kind: 'unverifiable', path: layout.program },
    ])
    expect(captureUninstallLeftovers([layout.program], hostOptions({ isForeignWritableDirectory: () => true }))).toEqual([
      { kind: 'unverifiable', path: layout.program },
    ])
    expect(captureUninstallLeftovers([layout.quarantine], hostOptions({ platform: 'win32', ownerUid: undefined }))).toEqual([
      { kind: 'unverifiable', path: layout.quarantine },
    ])
  })

  it.runIf(posixHost)('never pins a file whose directory is reached through a link', () => {
    const layout = leftoverDirectory()
    const linkedBin = path.join(layout.root, 'linked-bin')
    fs.symlinkSync(layout.bin, linkedBin)

    expect(captureUninstallLeftovers([path.join(linkedBin, 'grok-1.0.46')], hostOptions())).toEqual([
      { kind: 'unverifiable', path: path.join(linkedBin, 'grok-1.0.46') },
    ])
  })
})

describe('removeUninstallLeftovers', () => {
  it.runIf(posixHost)('deletes the recorded file and link after checking them again and leaves their neighbours alone', async () => {
    const layout = leftoverDirectory()
    fs.symlinkSync('grok-1.0.46', layout.quarantine)
    const leftovers = captureUninstallLeftovers([layout.quarantine, layout.program], hostOptions())

    await expect(removeUninstallLeftovers(leftovers, hostOptions())).resolves.toEqual({ removed: 2, reused: 0, kept: [] })
    expect(exists(layout.quarantine)).toBe(false)
    expect(exists(layout.program)).toBe(false)
    expect(fs.readFileSync(layout.neighbour, 'utf8')).toBe('keep')
  })

  it.runIf(posixHost)('removes a recorded link itself, never what it points at', async () => {
    const layout = leftoverDirectory()
    fs.symlinkSync('grok-1.0.46', layout.quarantine)
    const leftovers = captureUninstallLeftovers([layout.quarantine], hostOptions())

    await expect(removeUninstallLeftovers(leftovers, hostOptions())).resolves.toMatchObject({ removed: 1, kept: [] })
    expect(exists(layout.quarantine)).toBe(false)
    expect(fs.readFileSync(layout.program, 'utf8')).toBe('grok binary')
  })

  it('deletes a recorded regular file on every platform', async () => {
    const layout = leftoverDirectory()
    const leftovers = captureUninstallLeftovers([layout.program], hostOptions())
    expect(leftovers).toEqual([expect.objectContaining({ kind: 'pinned' })])

    await expect(removeUninstallLeftovers(leftovers, hostOptions())).resolves.toEqual({ removed: 1, reused: 0, kept: [] })
    expect(exists(layout.program)).toBe(false)
    expect(fs.readFileSync(layout.neighbour, 'utf8')).toBe('keep')
  })

  it('leaves a file that changed since the uninstall and keeps counting it', async () => {
    const layout = leftoverDirectory()
    const leftovers = captureUninstallLeftovers([layout.program], hostOptions())
    fs.appendFileSync(layout.program, ' patched')

    const cleanup = await removeUninstallLeftovers(leftovers, hostOptions())

    expect(cleanup).toMatchObject({ removed: 0, kept: [{ reason: 'file-changed' }] })
    expect(fs.readFileSync(layout.program, 'utf8')).toBe('grok binary patched')
  })

  it('treats a different file now under the recorded name as gone and does not touch it', async () => {
    const layout = leftoverDirectory()
    const leftovers = captureUninstallLeftovers([layout.program], hostOptions())
    // Written beside the old one first, so the new file cannot reuse its inode number.
    fs.writeFileSync(`${layout.program}.new`, 'reinstalled grok')
    fs.renameSync(`${layout.program}.new`, layout.program)

    await expect(removeUninstallLeftovers(leftovers, hostOptions())).resolves.toEqual({ removed: 0, reused: 0, kept: [] })
    expect(fs.readFileSync(layout.program, 'utf8')).toBe('reinstalled grok')
  })

  it.runIf(posixHost)('refuses to delete through a directory that was swapped for a link', async () => {
    const layout = leftoverDirectory()
    const leftovers = captureUninstallLeftovers([layout.program], hostOptions())
    const moved = path.join(layout.root, 'moved-bin')
    fs.renameSync(layout.bin, moved)
    fs.symlinkSync(moved, layout.bin)

    await expect(removeUninstallLeftovers(leftovers, hostOptions())).resolves.toMatchObject({
      removed: 0,
      kept: [{ reason: 'directory-changed' }],
    })
    expect(fs.readFileSync(path.join(moved, 'grok-1.0.46'), 'utf8')).toBe('grok binary')
  })

  it('refuses a directory that others can write to by the time of the cleanup', async () => {
    const layout = leftoverDirectory()
    const leftovers = captureUninstallLeftovers([layout.program], hostOptions())

    await expect(removeUninstallLeftovers(leftovers, hostOptions({ isForeignWritableDirectory: () => true }))).resolves
      .toMatchObject({ removed: 0, kept: [{ reason: 'directory-changed' }] })
    expect(exists(layout.program)).toBe(true)
  })

  it.runIf(posixHost)('keeps a program file that a reinstalled command runs again', async () => {
    const layout = leftoverDirectory()
    const leftovers = captureUninstallLeftovers([layout.program], hostOptions())
    // Grok's npm postinstall keeps an existing grok-<version> and only points the link back at it.
    const command = path.join(layout.bin, 'grok')
    fs.symlinkSync('grok-1.0.46', command)

    await expect(removeUninstallLeftovers(leftovers, { ...hostOptions(), liveCommandLinks: [command, path.join(layout.bin, 'agent')] }))
      .resolves.toEqual({ removed: 0, reused: 1, kept: [] })
    expect(fs.readFileSync(fs.realpathSync(command), 'utf8')).toBe('grok binary')
  })

  it('keeps a file whose delete fails so the next attempt can try it again', async () => {
    const layout = leftoverDirectory()
    const leftovers = captureUninstallLeftovers([layout.program], hostOptions())
    vi.spyOn(fs.promises, 'unlink').mockRejectedValueOnce(Object.assign(new Error('resource busy'), { code: 'EBUSY' }))

    const first = await removeUninstallLeftovers(leftovers, hostOptions())
    expect(first).toEqual({ removed: 0, reused: 0, kept: [{ leftover: leftovers[0], reason: 'delete-failed', code: 'EBUSY' }] })
    expect(exists(layout.program)).toBe(true)

    await expect(removeUninstallLeftovers(first.kept.map((entry) => entry.leftover), hostOptions())).resolves
      .toEqual({ removed: 1, reused: 0, kept: [] })
    expect(exists(layout.program)).toBe(false)
  })

  it('counts a file it may not delete only while that file is still there', async () => {
    const layout = leftoverDirectory()
    const hardLinked = path.join(layout.bin, 'grok-1.0.45')
    fs.writeFileSync(hardLinked, 'old grok')
    fs.linkSync(hardLinked, path.join(layout.root, 'elsewhere'))
    const leftovers = captureUninstallLeftovers([hardLinked], hostOptions())

    await expect(removeUninstallLeftovers(leftovers, hostOptions())).resolves.toMatchObject({
      removed: 0,
      kept: [{ reason: 'unverifiable' }],
    })
    expect(fs.readFileSync(hardLinked, 'utf8')).toBe('old grok')

    fs.unlinkSync(hardLinked)
    await expect(removeUninstallLeftovers(leftovers, hostOptions())).resolves.toEqual({ removed: 0, reused: 0, kept: [] })
  })
})

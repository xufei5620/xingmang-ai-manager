import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createReleaseGuardStore, parseStoredReleaseGuard } from './release-guard-store'

const directories: string[] = []

function temporaryFile(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-release-guard-'))
  directories.push(directory)
  return path.join(directory, 'release-guard.json')
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('release guard store', () => {
  it('reads nothing on a machine that never remembered a status file', () => {
    expect(createReleaseGuardStore({ filePath: temporaryFile() }).read()).toBeNull()
  })

  it('reads the remembered withdrawn list and rollout back from a fresh store', async () => {
    const filePath = temporaryFile()
    await createReleaseGuardStore({ filePath }).write({ badVersions: ['0.2.10', '0.2.20'], rollout: { version: '0.2.21', percent: 20 } })
    expect(createReleaseGuardStore({ filePath }).read()).toEqual({ badVersions: ['0.2.10', '0.2.20'], rollout: { version: '0.2.21', percent: 20 } })
  })

  it('remembers which status file the record came from, and reads a record without it as before', async () => {
    const filePath = temporaryFile()
    const guard = { badVersions: ['0.2.20'], rollout: null, updatedAt: '2026-10-18T02:00:00.000Z' }
    await createReleaseGuardStore({ filePath }).write(guard)
    expect(createReleaseGuardStore({ filePath }).read()).toEqual(guard)
    expect(parseStoredReleaseGuard(JSON.stringify({ version: 1, badVersions: ['0.2.20'], rollout: null })))
      .toEqual({ badVersions: ['0.2.20'], rollout: null })
  })

  it('keeps the later of two writes issued back to back', async () => {
    const filePath = temporaryFile()
    const store = createReleaseGuardStore({ filePath })
    await Promise.all([
      store.write({ badVersions: ['0.2.10'], rollout: { version: '0.2.21', percent: 20 } }),
      store.write({ badVersions: ['0.2.10'], rollout: null }),
    ])
    expect(store.read()).toEqual({ badVersions: ['0.2.10'], rollout: null })
  })

  it('treats a damaged or foreign record as never remembered', () => {
    expect(parseStoredReleaseGuard('not json')).toBeNull()
    expect(parseStoredReleaseGuard('[]')).toBeNull()
    expect(parseStoredReleaseGuard(JSON.stringify({ badVersions: ['0.2.10'], rollout: null }))).toBeNull()
    expect(parseStoredReleaseGuard(JSON.stringify({ version: 2, badVersions: ['0.2.10'], rollout: null }))).toBeNull()
  })

  it('revalidates every entry the way the status file is read', () => {
    expect(parseStoredReleaseGuard(JSON.stringify({ version: 1, badVersions: ['v0.2.10', '../x', 3, '0.2.10'], rollout: { version: 'x', percent: 20 } })))
      .toEqual({ badVersions: ['0.2.10'], rollout: null })
    expect(parseStoredReleaseGuard(JSON.stringify({ version: 1, badVersions: 'oops', rollout: { version: '0.2.21', percent: 150 } })))
      .toEqual({ badVersions: [], rollout: { version: '0.2.21', percent: 100 } })
  })

  it('reads an oversized record as never remembered', () => {
    const filePath = temporaryFile()
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, badVersions: [], rollout: null, padding: 'x'.repeat(32 * 1024) }))
    expect(createReleaseGuardStore({ filePath }).read()).toBeNull()
  })

  it('refuses a relative path', () => {
    expect(() => createReleaseGuardStore({ filePath: 'release-guard.json' })).toThrow('绝对路径')
  })
})

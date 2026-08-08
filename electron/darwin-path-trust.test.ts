import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isDarwinForeignWritablePath,
  posixPathComponents,
  type DarwinPathStats,
  type DarwinPathTrustProbe,
} from './darwin-path-trust'

const testUid = 501
const staffGid = 20
const adminGid = 80

function componentStats(overrides: Partial<DarwinPathStats> = {}): DarwinPathStats {
  return {
    uid: 0,
    gid: 0,
    mode: 0o40755,
    isSymbolicLink: () => false,
    ...overrides,
  }
}

/** Builds a probe whose whole ancestor chain is root-owned 0755 unless overridden. */
function chainProbe(
  leaf: string,
  overrides: Record<string, Partial<DarwinPathStats>> = {},
  effectiveUid = testUid,
): DarwinPathTrustProbe {
  const entries = new Map<string, DarwinPathStats>()
  for (const component of posixPathComponents(leaf)) {
    entries.set(component, componentStats(overrides[component]))
  }
  return {
    realpathSync: (filePath) => filePath,
    lstatSync: (filePath) => {
      const found = entries.get(filePath)
      if (!found) throw new Error(`unexpected lstat: ${filePath}`)
      return found
    },
    geteuid: () => effectiveUid,
  }
}

describe('darwin path trust', () => {
  it('lists every ancestor from the root down to the leaf', () => {
    expect(posixPathComponents('/usr/local/bin/codex'))
      .toEqual(['/', '/usr', '/usr/local', '/usr/local/bin', '/usr/local/bin/codex'])
    expect(posixPathComponents('/')).toEqual(['/'])
  })

  it('trusts a chain owned entirely by root', () => {
    expect(isDarwinForeignWritablePath('/usr/bin/codex', chainProbe('/usr/bin/codex'))).toBe(false)
  })

  it('trusts paths the invoking user owns, which is the whole point on macOS', () => {
    // Every managed CLI lives under $HOME. Rejecting user-owned paths the way the
    // Windows predicate does would refuse to launch anything this product installs.
    const leaf = '/Users/tester/.local/bin/codex'
    expect(isDarwinForeignWritablePath(leaf, chainProbe(leaf, {
      '/Users/tester': { uid: testUid, gid: staffGid, mode: 0o40750 },
      '/Users/tester/.local': { uid: testUid, gid: staffGid },
      '/Users/tester/.local/bin': { uid: testUid, gid: staffGid },
      '/Users/tester/.local/bin/codex': { uid: testUid, gid: staffGid, mode: 0o100755 },
    }))).toBe(false)
  })

  it('rejects a component owned by a third principal', () => {
    const leaf = '/Users/other/bin/codex'
    expect(isDarwinForeignWritablePath(leaf, chainProbe(leaf, {
      '/Users/other': { uid: 502, gid: staffGid },
    }))).toBe(true)
  })

  it('rejects a world-writable component even when the sticky bit is set', () => {
    // +t stops one user deleting another's file but not creating a new name, so a
    // fixed-name path under /private/tmp is still squattable.
    const leaf = '/private/tmp/codex'
    expect(isDarwinForeignWritablePath(leaf, chainProbe(leaf, {
      '/private/tmp': { mode: 0o41777 },
    }))).toBe(true)
  })

  it('rejects group-writable to a group that is not wheel or admin', () => {
    const leaf = '/opt/shared/bin/codex'
    expect(isDarwinForeignWritablePath(leaf, chainProbe(leaf, {
      '/opt/shared': { uid: 0, gid: staffGid, mode: 0o40775 },
    }))).toBe(true)
  })

  it('accepts group-writable to admin, whose members stock sudoers already makes root', () => {
    // This is the one deliberate product decision in the predicate. Homebrew ships
    // /opt/homebrew as 0775 root:admin on machines where the user did not take
    // ownership, and defending against admin would defend a boundary macOS does not
    // draw. The app cannot read /etc/sudoers (0440 root) to confirm it.
    const leaf = '/opt/homebrew/bin/codex'
    expect(isDarwinForeignWritablePath(leaf, chainProbe(leaf, {
      '/opt/homebrew': { uid: 0, gid: adminGid, mode: 0o40775 },
      '/opt/homebrew/bin': { uid: 0, gid: adminGid, mode: 0o40775 },
    }))).toBe(false)
  })

  it('rejects a pristine leaf whose parent directory is writable by others', () => {
    // Replacement is governed by write permission on the parent, not on the file, so
    // walking only the leaf would call this trusted. This is the ancestor walk's
    // entire reason for existing.
    const leaf = '/opt/exposed/bin/codex'
    expect(isDarwinForeignWritablePath(leaf, chainProbe(leaf, {
      '/opt/exposed/bin': { mode: 0o40777 },
      '/opt/exposed/bin/codex': { uid: 0, gid: 0, mode: 0o100755 },
    }))).toBe(true)
  })

  it('rejects a component that is still a symbolic link after realpath', () => {
    const leaf = '/usr/local/bin/codex'
    expect(isDarwinForeignWritablePath(leaf, chainProbe(leaf, {
      '/usr/local': { isSymbolicLink: () => true },
    }))).toBe(true)
  })

  it('fails closed when the path cannot be resolved or inspected', () => {
    const leaf = '/usr/bin/codex'
    expect(isDarwinForeignWritablePath(leaf, {
      realpathSync: () => { throw new Error('ENOENT') },
      lstatSync: () => componentStats(),
      geteuid: () => testUid,
    })).toBe(true)
    expect(isDarwinForeignWritablePath(leaf, {
      realpathSync: (filePath) => filePath,
      lstatSync: () => { throw new Error('EACCES') },
      geteuid: () => testUid,
    })).toBe(true)
    // A realpath that answers with a relative path cannot be walked safely.
    expect(isDarwinForeignWritablePath(leaf, {
      realpathSync: () => 'usr/bin/codex',
      lstatSync: () => componentStats(),
      geteuid: () => testUid,
    })).toBe(true)
  })

  it('rejects malformed inputs instead of treating them as trusted', () => {
    const probe = chainProbe('/usr/bin/codex')
    expect(isDarwinForeignWritablePath('', probe)).toBe(true)
    expect(isDarwinForeignWritablePath('bin/codex', probe)).toBe(true)
    expect(isDarwinForeignWritablePath('/usr/bin/co\0dex', probe)).toBe(true)
  })

  it('degrades to trusting only root when the effective uid is unavailable', () => {
    // process.geteuid does not exist on Windows, so the fallback must not accidentally
    // match a real account.
    const leaf = '/Users/tester/bin/codex'
    const probe = chainProbe(leaf, {
      '/Users/tester': { uid: testUid, gid: staffGid },
      '/Users/tester/bin': { uid: testUid, gid: staffGid },
      '/Users/tester/bin/codex': { uid: testUid, gid: staffGid, mode: 0o100755 },
    })
    expect(isDarwinForeignWritablePath(leaf, { ...probe, geteuid: () => -1 })).toBe(true)
  })

  it.runIf(process.platform === 'darwin')('agrees with this machine on the fixed system directories', () => {
    expect(isDarwinForeignWritablePath('/usr/bin')).toBe(false)
    expect(isDarwinForeignWritablePath('/bin')).toBe(false)
    expect(isDarwinForeignWritablePath('/usr/bin/codesign')).toBe(false)
    expect(isDarwinForeignWritablePath('/private/tmp')).toBe(true)
    expect(isDarwinForeignWritablePath('/Users/Shared')).toBe(true)
  })

  // Must never be deleted or weakened: if this fails, the app can no longer launch
  // the CLIs it exists to manage. Any future tightening has to keep it green.
  it.runIf(process.platform === 'darwin')('keeps the app-owned locations it must execute from trusted', () => {
    // The per-user Darwin temp directory is where verified CLI copies are staged.
    expect(isDarwinForeignWritablePath(os.tmpdir())).toBe(false)
    expect(isDarwinForeignWritablePath(os.homedir())).toBe(false)
    // The Node binary running this test stands in for a user-scoped managed CLI.
    expect(isDarwinForeignWritablePath(fs.realpathSync(process.execPath))).toBe(false)
  })

  it.runIf(process.platform === 'darwin')('costs far less than a subprocess probe', () => {
    // The predicate sits in a synchronous path, which is why SIP flags and ACLs are
    // deliberately not read: both would need a spawn per component.
    const target = '/usr/bin/codesign'
    const started = process.hrtime.bigint()
    for (let index = 0; index < 200; index += 1) isDarwinForeignWritablePath(target)
    const perCallMicroseconds = Number(process.hrtime.bigint() - started) / 200 / 1000
    expect(perCallMicroseconds).toBeLessThan(2000)
  })

  it.runIf(process.platform === 'darwin')('rejects a directory the test makes world-writable', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-darwin-trust-'))
    try {
      const exposed = path.join(directory, 'bin')
      fs.mkdirSync(exposed)
      const leaf = path.join(exposed, 'codex')
      fs.writeFileSync(leaf, '#!/bin/sh\n', { mode: 0o700 })
      expect(isDarwinForeignWritablePath(leaf)).toBe(false)
      fs.chmodSync(exposed, 0o777)
      expect(isDarwinForeignWritablePath(leaf)).toBe(true)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})

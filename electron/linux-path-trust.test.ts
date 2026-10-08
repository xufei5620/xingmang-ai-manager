import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  isLinuxForeignWritablePath,
  linuxGroupHoldersAreTrusted,
  parseLinuxAccountDatabase,
  type LinuxAccountFile,
  type LinuxPathStats,
  type LinuxPathTrustProbe,
} from './linux-path-trust'

const alice = 1000

interface FakeEntry {
  uid: number
  gid: number
  mode: number
  link?: string
}

const directory = (uid: number, gid: number, mode: number): FakeEntry => ({ uid, gid, mode: 0o040000 | mode })
const file = (uid: number, gid: number, mode: number): FakeEntry => ({ uid, gid, mode: 0o100000 | mode })
const link = (target: string, uid = 0): FakeEntry => ({ uid, gid: uid, mode: 0o120777, link: target })

const ubuntuGroup = [
  'root:x:0:',
  'sudo:x:27:alice',
  'staff:x:50:',
  'users:x:100:',
  'alice:x:1000:',
  'bob:x:1001:',
  'shared:x:2000:alice,bob',
].join('\n')
const ubuntuPasswd = [
  'root:x:0:0:root:/root:/bin/bash',
  'alice:x:1000:1000:Alice:/home/alice:/bin/bash',
  'bob:x:1001:1001:Bob:/home/bob:/bin/bash',
].join('\n')

function fakeTree(
  entries: Record<string, FakeEntry>,
  options: { euid?: number, group?: string | null, passwd?: string | null } = {},
): LinuxPathTrustProbe & { accountReads: LinuxAccountFile[] } {
  const accountReads: LinuxAccountFile[] = []
  function resolveLinks(target: string, depth = 0): string {
    if (depth > 16) throw new Error('ELOOP')
    const parts = target.split('/').filter(Boolean)
    let current = '/'
    for (const [index, part] of parts.entries()) {
      const next = path.posix.join(current, part)
      const entry = entries[next]
      if (!entry) throw Object.assign(new Error(`ENOENT ${next}`), { code: 'ENOENT' })
      if (entry.link) {
        const rest = parts.slice(index + 1)
        const base = path.posix.isAbsolute(entry.link) ? entry.link : path.posix.join(current, entry.link)
        return resolveLinks(path.posix.join(base, ...rest), depth + 1)
      }
      current = next
    }
    return current
  }
  return {
    accountReads,
    geteuid: () => options.euid ?? alice,
    realpathSync: (target) => resolveLinks(target),
    lstatSync: (target): LinuxPathStats => {
      // lstat follows every intermediate link, then reports the last component itself.
      const parent = path.posix.dirname(target)
      const resolvedParent = target === '/' ? '/' : resolveLinks(parent)
      const own = target === '/' ? '/' : path.posix.join(resolvedParent, path.posix.basename(target))
      const entry = entries[own]
      if (!entry) throw Object.assign(new Error(`ENOENT ${own}`), { code: 'ENOENT' })
      return { uid: entry.uid, gid: entry.gid, mode: entry.mode, isSymbolicLink: () => Boolean(entry.link) }
    },
    readAccountFile: (filePath) => {
      accountReads.push(filePath)
      return filePath === '/etc/group'
        ? (options.group === undefined ? ubuntuGroup : options.group)
        : (options.passwd === undefined ? ubuntuPasswd : options.passwd)
    },
  }
}

const systemTree: Record<string, FakeEntry> = {
  '/': directory(0, 0, 0o755),
  '/usr': directory(0, 0, 0o755),
  '/usr/bin': directory(0, 0, 0o755),
  '/usr/bin/node': file(0, 0, 0o755),
  '/bin': link('usr/bin'),
  '/usr/local': directory(0, 50, 0o2775),
  '/usr/local/bin': directory(0, 50, 0o2775),
  '/usr/local/bin/node': file(0, 50, 0o755),
  '/tmp': directory(0, 0, 0o1777),
  '/home': directory(0, 0, 0o755),
  '/home/alice': directory(alice, alice, 0o750),
  '/home/alice/.local': directory(alice, alice, 0o775),
  '/home/alice/.local/bin': directory(alice, alice, 0o775),
  '/home/alice/.local/bin/claude': file(alice, alice, 0o775),
  '/home/bob': directory(1001, 1001, 0o755),
  '/home/bob/bin': directory(1001, 1001, 0o755),
  '/home/bob/bin/node': file(1001, 1001, 0o755),
}

describe('Linux path trust', () => {
  it('trusts the user own tree under a user-private group with umask 002', () => {
    expect(isLinuxForeignWritablePath('/home/alice/.local/bin/claude', fakeTree(systemTree))).toBe(false)
  })

  it('trusts root-owned system binaries, including through the merged-/usr link', () => {
    const probe = fakeTree(systemTree)
    expect(isLinuxForeignWritablePath('/usr/bin/node', probe)).toBe(false)
    expect(isLinuxForeignWritablePath('/bin/node', probe)).toBe(false)
    // Nothing on either path is group-writable by a non-root group, so the account
    // files are never opened.
    expect(probe.accountReads).toEqual([])
  })

  it('trusts a root:staff 2775 /usr/local while staff has nobody in it', () => {
    expect(isLinuxForeignWritablePath('/usr/local/bin/node', fakeTree(systemTree))).toBe(false)
  })

  it('distrusts /usr/local once another account joins its group', () => {
    const group = ubuntuGroup.replace('staff:x:50:', 'staff:x:50:bob')
    expect(isLinuxForeignWritablePath('/usr/local/bin/node', fakeTree(systemTree, { group }))).toBe(true)
  })

  it('distrusts a group another account holds as its primary group', () => {
    const passwd = `${ubuntuPasswd}\ncarol:x:1002:1000:Carol:/home/carol:/bin/bash`
    expect(isLinuxForeignWritablePath('/home/alice/.local/bin/claude', fakeTree(systemTree, { passwd }))).toBe(true)
  })

  it('distrusts a directory shared with a group that has another member', () => {
    const tree = {
      ...systemTree,
      '/home/alice/.local/bin': directory(alice, 2000, 0o775),
    }
    expect(isLinuxForeignWritablePath('/home/alice/.local/bin/claude', fakeTree(tree))).toBe(true)
  })

  it('distrusts another account tree, world-writable directories and sticky /tmp', () => {
    const tree = {
      ...systemTree,
      '/opt': directory(0, 0, 0o755),
      '/opt/tools': directory(0, 0, 0o777),
      '/opt/tools/node': file(0, 0, 0o755),
      '/tmp/node': file(alice, alice, 0o755),
    }
    const probe = fakeTree(tree)
    expect(isLinuxForeignWritablePath('/home/bob/bin/node', probe)).toBe(true)
    expect(isLinuxForeignWritablePath('/opt/tools/node', probe)).toBe(true)
    expect(isLinuxForeignWritablePath('/tmp/node', probe)).toBe(true)
  })

  it('distrusts a symlink in the user tree that escapes into a world-writable directory', () => {
    const tree = {
      ...systemTree,
      '/home/alice/bin': link('/tmp/drop', alice),
      '/tmp/drop': directory(alice, alice, 0o755),
      '/tmp/drop/node': file(alice, alice, 0o755),
    }
    expect(isLinuxForeignWritablePath('/home/alice/bin/node', fakeTree(tree))).toBe(true)
  })

  it('distrusts a link that a foreign principal could repoint even when it targets /usr/bin today', () => {
    const tree = {
      ...systemTree,
      '/tmp/bin': link('/usr/bin', alice),
    }
    // The resolved chain is pristine; the lexical one sits in sticky /tmp, where the link
    // can be replaced between this check and the PATH lookup that uses its spelling.
    expect(isLinuxForeignWritablePath('/tmp/bin/node', fakeTree(tree))).toBe(true)
  })

  it('distrusts a link owned by another account even inside a trusted directory', () => {
    const tree = {
      ...systemTree,
      '/home/alice/.local/bin/node': link('/usr/bin/node', 1001),
    }
    expect(isLinuxForeignWritablePath('/home/alice/.local/bin/node', fakeTree(tree))).toBe(true)
  })

  it('fails closed when the group database cannot settle the question', () => {
    const tree = {
      ...systemTree,
      '/home/alice/.local/bin': directory(alice, 4242, 0o775),
    }
    // A gid the files do not describe (LDAP, SSSD) cannot be checked.
    expect(isLinuxForeignWritablePath('/home/alice/.local/bin/claude', fakeTree(tree))).toBe(true)
    // Unreadable or untrusted account files, and NIS compat entries.
    expect(isLinuxForeignWritablePath('/home/alice/.local/bin/claude', fakeTree(systemTree, { group: null }))).toBe(true)
    expect(isLinuxForeignWritablePath('/home/alice/.local/bin/claude', fakeTree(systemTree, { passwd: null }))).toBe(true)
    expect(isLinuxForeignWritablePath('/home/alice/.local/bin/claude', fakeTree(systemTree, { group: `${ubuntuGroup}\n+:::` })))
      .toBe(true)
  })

  it('credits gid 0 without reading the account files', () => {
    const tree = {
      ...systemTree,
      '/opt': directory(0, 0, 0o775),
      '/opt/node': file(0, 0, 0o755),
    }
    const probe = fakeTree(tree, { group: null, passwd: null })
    expect(isLinuxForeignWritablePath('/opt/node', probe)).toBe(false)
    expect(probe.accountReads).toEqual([])
  })

  it('reads the account files at most once per question', () => {
    const probe = fakeTree(systemTree)
    expect(isLinuxForeignWritablePath('/home/alice/.local/bin/claude', probe)).toBe(false)
    expect(probe.accountReads).toEqual(['/etc/group', '/etc/passwd'])
  })

  it('trusts only root for a caller whose uid matches no account', () => {
    // The production fallback for a missing geteuid is -1, which behaves exactly so.
    const probe = { ...fakeTree(systemTree), geteuid: () => -1 }
    expect(isLinuxForeignWritablePath('/home/alice/.local/bin/claude', probe)).toBe(true)
    expect(isLinuxForeignWritablePath('/usr/bin/node', probe)).toBe(false)
  })

  it('rejects relative, dotted, empty, NUL-bearing and unresolvable paths', () => {
    const probe = fakeTree(systemTree)
    for (const candidate of ['usr/bin/node', '/usr/bin/../bin/node', '/usr/./bin/node', '', '/usr/bin/no\0de', '/usr/bin/missing']) {
      expect(isLinuxForeignWritablePath(candidate, probe)).toBe(true)
    }
  })

  it('fails closed when a component changes into a link between realpath and lstat', () => {
    const probe = fakeTree(systemTree)
    const lstatSync = vi.fn((target: string) => {
      const stats = probe.lstatSync!(target)
      return target === '/usr/bin' ? { ...stats, isSymbolicLink: () => true } : stats
    })
    expect(isLinuxForeignWritablePath('/home/alice/.local/bin/claude', { ...probe, lstatSync })).toBe(false)
    // Resolved chain differs from the lexical one only through /bin, and /usr/bin turning
    // into a link there means the tree moved underneath the check.
    expect(isLinuxForeignWritablePath('/bin/node', { ...probe, lstatSync })).toBe(true)
  })

  it.runIf(process.platform === 'linux')('answers the real filesystem: system binaries trusted, /tmp never', () => {
    expect(isLinuxForeignWritablePath('/usr/bin/env')).toBe(false)
    const scratch = fs.mkdtempSync('/tmp/xingmang-linux-trust-')
    try {
      const target = path.join(scratch, 'node')
      fs.writeFileSync(target, '', { mode: 0o755 })
      expect(isLinuxForeignWritablePath(target)).toBe(true)
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true })
    }
  })
})

describe('Linux account database', () => {
  it('unions members of entries that share a gid and maps primary groups', () => {
    const database = parseLinuxAccountDatabase(
      'one:x:300:alice\ntwo:x:300:bob\n',
      'alice:x:1000:1000::/home/alice:/bin/sh\nbob:x:1001:300::/home/bob:/bin/sh\n',
    )
    expect(database?.memberNamesByGid.get(300)).toEqual(['alice', 'bob'])
    expect(database?.primaryUidsByGid.get(300)).toEqual([1001])
    expect(linuxGroupHoldersAreTrusted(300, 1000, database)).toBe(false)
  })

  it('treats members it cannot map to a uid as foreign', () => {
    const database = parseLinuxAccountDatabase('dev:x:500:ldapuser\n', 'alice:x:1000:1000::/home/alice:/bin/sh\n')
    expect(linuxGroupHoldersAreTrusted(500, 1000, database)).toBe(false)
  })

  it('discards a database with malformed or compat lines', () => {
    expect(parseLinuxAccountDatabase('broken-line\n', ubuntuPasswd)).toBeNull()
    expect(parseLinuxAccountDatabase(ubuntuGroup, 'alice:x:notanumber:1000::/home/alice:/bin/sh')).toBeNull()
    expect(parseLinuxAccountDatabase(ubuntuGroup, `${ubuntuPasswd}\n+@netgroup::::::`)).toBeNull()
    expect(linuxGroupHoldersAreTrusted(1000, 1000, null)).toBe(false)
  })

  it('accepts a group whose only holders are root and the invoking user', () => {
    const database = parseLinuxAccountDatabase(ubuntuGroup, ubuntuPasswd)
    expect(linuxGroupHoldersAreTrusted(27, alice, database)).toBe(true)
    expect(linuxGroupHoldersAreTrusted(1000, alice, database)).toBe(true)
    expect(linuxGroupHoldersAreTrusted(1001, alice, database)).toBe(false)
  })
})

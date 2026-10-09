// Windows only grants SeCreateSymbolicLinkPrivilege to an elevated process or when Developer Mode
// is on, and neither is the default. The checks that prove the reparse-point defences (I8) need a
// real symbolic link — a junction takes a different branch — so on an ordinary developer machine
// fs.symlinkSync threw EPERM before the code under test ever ran, and nine checks reported a
// machine configuration rather than anything about this repository (#40).
//
// Gating on the capability instead of on the platform leaves every assertion intact: the checks
// still run wherever a symbolic link can be made, which includes the CI runners. The companion
// guard check exists so that coverage cannot vanish quietly — if a runner ever loses the
// privilege, it turns red instead of nine checks turning into silent skips.
//
// Test-only: tsconfig.electron.json excludes *.test-support.ts, so none of this reaches
// dist-electron.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function probeSymbolicLinkCapability(): boolean {
  let directory: string | null = null
  try {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-symlink-probe-'))
    // A dangling target is enough: the privilege is checked before the target is resolved.
    fs.symlinkSync(path.join(directory, 'missing-target'), path.join(directory, 'link'))
    return true
  } catch {
    return false
  } finally {
    if (directory) fs.rmSync(directory, { recursive: true, force: true })
  }
}

/** Whether this machine can create a real symbolic link. Probed once per test process. */
export const canCreateSymbolicLink = probeSymbolicLinkCapability()

/** CI has to keep running the gated checks, so a lost privilege has to fail loudly there. */
export const symlinkCoverageRequired = Boolean(process.env.CI)

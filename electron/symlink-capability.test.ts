import { describe, expect, it } from 'vitest'
import { canCreateSymbolicLink, symlinkCoverageRequired } from './symlink-capability.test-support'

describe('symbolic link capability', () => {
  it('answers without throwing on every platform', () => {
    expect(typeof canCreateSymbolicLink).toBe('boolean')
  })

  // Nine checks across safe-local-data, runtime-log, backups, path-identity and relocated-folders
  // are gated on the probe. If a runner ever loses the privilege they would all turn into skips
  // and the I8 reparse-point defences would stop being verified anywhere, so CI fails here first.
  it.runIf(symlinkCoverageRequired)('is present on CI, where the gated checks must really run', () => {
    expect(canCreateSymbolicLink).toBe(true)
  })
})

import { describe, expect, it, vi } from 'vitest'
import {
  buildSetUserCertificateTrustScript,
  inspectUserWideCertificateTrust,
  parseSetUserCertificateTrustOutput,
  trustCertificatesForUserTerminals,
} from './user-certificate-trust'

describe('inspectUserWideCertificateTrust', () => {
  it('is only offered to a normal start on Windows', () => {
    expect(inspectUserWideCertificateTrust({ platform: 'darwin', executionMode: 'same-user', env: {} })).toBe('unsupported')
    expect(inspectUserWideCertificateTrust({ platform: 'win32', executionMode: 'trusted-only', env: {} })).toBe('unsupported')
    expect(inspectUserWideCertificateTrust({ platform: 'win32', executionMode: 'same-user', env: {} })).toBe('available')
  })

  it('reads the inherited value in any letter case', () => {
    expect(inspectUserWideCertificateTrust({ platform: 'win32', executionMode: 'same-user', env: { node_use_system_ca: '1' } })).toBe('applied')
    expect(inspectUserWideCertificateTrust({ platform: 'win32', executionMode: 'same-user', env: { NODE_USE_SYSTEM_CA: '0' } })).toBe('userSet')
  })
})

describe('buildSetUserCertificateTrustScript', () => {
  it('writes only the one fixed name for the current user and leaves an existing value alone', () => {
    const script = buildSetUserCertificateTrustScript()
    expect(script).toContain('[Environment]::SetEnvironmentVariable("NODE_USE_SYSTEM_CA", "1", "User")')
    expect(script).toContain('if ($null -ne $current)')
    expect(script).not.toContain('"Machine"')
    expect(script).not.toMatch(/\$env:/)
  })
})

describe('parseSetUserCertificateTrustOutput', () => {
  it('maps the last line and refuses anything else', () => {
    expect(parseSetUserCertificateTrustOutput('noise\r\nset\r\n')).toBe('applied')
    expect(parseSetUserCertificateTrustOutput('present-on')).toBe('applied')
    expect(parseSetUserCertificateTrustOutput('present-other')).toBe('userSet')
    expect(() => parseSetUserCertificateTrustOutput('')).toThrow('没能确认')
  })
})

describe('trustCertificatesForUserTerminals', () => {
  it('writes through PowerShell and syncs this process so the button goes away', async () => {
    const env: NodeJS.ProcessEnv = {}
    const run = vi.fn(async (_script: string, _env: NodeJS.ProcessEnv) => 'set\n')
    await expect(trustCertificatesForUserTerminals({ platform: 'win32', executionMode: 'same-user', env, run })).resolves.toBe('applied')
    expect(run).toHaveBeenCalledOnce()
    expect(run.mock.calls[0][0]).toBe(buildSetUserCertificateTrustScript())
    // The scrubbed environment never carries the switch into PowerShell.
    expect(Object.keys(run.mock.calls[0][1]).some((name) => name.toLowerCase() === 'node_use_system_ca')).toBe(false)
    expect(env.NODE_USE_SYSTEM_CA).toBe('1')
    expect(inspectUserWideCertificateTrust({ platform: 'win32', executionMode: 'same-user', env })).toBe('applied')
  })

  it('leaves a value the user chose, and this process, untouched', async () => {
    const env: NodeJS.ProcessEnv = {}
    const run = vi.fn(async () => 'present-other')
    await expect(trustCertificatesForUserTerminals({ platform: 'win32', executionMode: 'same-user', env, run })).resolves.toBe('userSet')
    expect(env).toEqual({})
  })

  it('refuses under an administrator start and off Windows without starting anything', async () => {
    const run = vi.fn(async () => 'set')
    await expect(trustCertificatesForUserTerminals({ platform: 'win32', executionMode: 'trusted-only', env: {}, run })).rejects.toThrow('管理员身份')
    await expect(trustCertificatesForUserTerminals({ platform: 'darwin', executionMode: 'same-user', env: {}, run })).rejects.toThrow('只有 Windows')
    expect(run).not.toHaveBeenCalled()
  })
})

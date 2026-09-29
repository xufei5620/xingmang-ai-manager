import { describe, expect, it } from 'vitest'
import { trustedCommandEnvironment } from './command-runner'
import {
  nodeReadsSystemCertificates,
  systemCertificateTrustVariable,
  toolCertificateFailureKind,
  withSystemCertificateTrust,
} from './system-certificate-trust'

describe('system certificate trust', () => {
  it('adds the variable without touching the caller environment', () => {
    const base = { PATH: '/usr/bin' }
    const env = withSystemCertificateTrust(base)
    expect(env[systemCertificateTrustVariable]).toBe('1')
    expect(base).toEqual({ PATH: '/usr/bin' })
  })

  it('keeps a value the user set in any letter case', () => {
    expect(withSystemCertificateTrust({ NODE_USE_SYSTEM_CA: '0' })).toEqual({ NODE_USE_SYSTEM_CA: '0' })
    expect(withSystemCertificateTrust({ node_use_system_ca: '0' })).toEqual({ node_use_system_ca: '0' })
  })

  it('never survives the elevated environment', () => {
    const env = trustedCommandEnvironment(withSystemCertificateTrust({ PATH: '/usr/bin' }), undefined, 'linux')
    expect(Object.keys(env).some((key) => key.toLowerCase() === 'node_use_system_ca')).toBe(false)
  })

  it('knows which Node.js releases read the variable', () => {
    for (const version of ['v22.19.0', 'v22.22.2', 'v24.6.0', '24.11.1', 'v25.0.0', 'v26.1.0']) {
      expect([version, nodeReadsSystemCertificates(version)]).toEqual([version, true])
    }
    for (const version of ['v18.20.4', 'v20.19.0', 'v22.18.0', 'v23.11.0', 'v24.5.0']) {
      expect([version, nodeReadsSystemCertificates(version)]).toEqual([version, false])
    }
    expect(nodeReadsSystemCertificates(null)).toBeNull()
    expect(nodeReadsSystemCertificates('custom build')).toBeNull()
  })

  it('blames the elevated app first, then an outdated Node.js, and otherwise nothing', () => {
    expect(toolCertificateFailureKind({ trustedOnly: true, nodeVersion: 'v24.11.0' })).toBe('elevated')
    expect(toolCertificateFailureKind({ trustedOnly: false, nodeVersion: 'v20.19.0' })).toBe('outdatedNode')
    expect(toolCertificateFailureKind({ trustedOnly: false, nodeVersion: 'v24.11.0' })).toBeNull()
    // 读不出版本就不叫人去换 Node.js。
    expect(toolCertificateFailureKind({ trustedOnly: false, nodeVersion: null })).toBeNull()
  })
})

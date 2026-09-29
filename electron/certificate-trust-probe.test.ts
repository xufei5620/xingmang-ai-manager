import { execFile } from 'node:child_process'
import net from 'node:net'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  buildNodeTlsProbeScript,
  certificateTrustVerdict,
  nodeTlsProbeEnvironment,
  parseNodeTlsProbeOutput,
} from './certificate-trust-probe'

const execFileAsync = promisify(execFile)

describe('certificate-trust-probe', () => {
  it('reads only the fixed marker line the script prints', () => {
    expect(parseNodeTlsProbeOutput('ok v22.19.0\n')).toEqual({ outcome: 'ok', version: 'v22.19.0' })
    expect(parseNodeTlsProbeOutput('cert v20.11.1\r\n')).toEqual({ outcome: 'cert', version: 'v20.11.1' })
    expect(parseNodeTlsProbeOutput('Error: unable to get local issuer certificate')).toEqual({ outcome: 'other', version: null })
    expect(parseNodeTlsProbeOutput('')).toEqual({ outcome: 'other', version: null })
  })

  it('removes the switch in any letter case for the plain run and forces it on for the other', () => {
    const env = { PATH: '/usr/bin', node_use_system_ca: '0' }
    expect(nodeTlsProbeEnvironment(env, false)).toEqual({ PATH: '/usr/bin' })
    expect(nodeTlsProbeEnvironment(env, true)).toEqual({ PATH: '/usr/bin', NODE_USE_SYSTEM_CA: '1' })
  })

  it('tells the five situations apart', () => {
    expect(certificateTrustVerdict({ defaultRoots: 'ok', systemRoots: 'cert', nodeVersion: 'v22.19.0' })).toBe('direct')
    expect(certificateTrustVerdict({ defaultRoots: 'cert', systemRoots: 'ok', nodeVersion: 'v22.19.0' })).toBe('systemTrusted')
    expect(certificateTrustVerdict({ defaultRoots: 'cert', systemRoots: 'cert', nodeVersion: 'v22.18.0' })).toBe('outdatedNode')
    expect(certificateTrustVerdict({ defaultRoots: 'cert', systemRoots: 'cert', nodeVersion: 'v24.6.0' })).toBe('untrusted')
    // 认不出版本号时不叫用户去换 Node。
    expect(certificateTrustVerdict({ defaultRoots: 'cert', systemRoots: 'cert', nodeVersion: null })).toBe('untrusted')
    expect(certificateTrustVerdict({ defaultRoots: 'other', systemRoots: 'ok', nodeVersion: 'v22.19.0' })).toBe('unknown')
    expect(certificateTrustVerdict({ defaultRoots: 'cert', systemRoots: 'other', nodeVersion: 'v22.19.0' })).toBe('unknown')
  })

  it('reports a refused connection as other without printing the upstream error', async () => {
    const server = net.createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port
    await new Promise<void>((resolve) => server.close(() => resolve()))

    const { stdout, stderr } = await execFileAsync(process.execPath, ['-e', buildNodeTlsProbeScript(), '127.0.0.1', String(port)], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 10_000,
    })

    expect(parseNodeTlsProbeOutput(stdout)).toEqual({ outcome: 'other', version: process.version })
    expect(stdout).not.toMatch(/ECONNREFUSED/)
    expect(stderr).toBe('')
  })
})

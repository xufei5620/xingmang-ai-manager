import { describe, expect, it } from 'vitest'
import { parse, stringify } from 'yaml'
import { buildIsolatedMihomoConfig, MAX_ACCELERATION_CLASH_BYTES, parseClashAccelerationProfile } from './acceleration-clash-config'

function source(overrides: Record<string, unknown> = {}, nodeOverrides: Record<string, unknown> = {}): string {
  return stringify({
    proxies: [{
      name: 'Test line',
      type: 'hysteria2',
      server: 'node.example.com',
      port: 443,
      password: 'test-only-password',
      sni: 'tls.example.com',
      up: 100,
      down: 200,
      'skip-cert-verify': true,
      ...nodeOverrides,
    }],
    ...overrides,
  })
}

describe('parseClashAccelerationProfile', () => {
  it('projects the supported inline connection and reports insecure TLS', () => {
    const profile = parseClashAccelerationProfile(source())
    expect(profile).toMatchObject({ sourceNodeCount: 1, unsupportedNodeCount: 0, insecureTlsNodeCount: 1 })
    expect(profile.nodes[0]).toEqual({
      id: 'line-1', label: '全球线路 1', region: 'GLOBAL', protocol: 'hysteria2',
      connection: { type: 'hysteria2', server: 'node.example.com', port: 443, password: 'test-only-password', sni: 'tls.example.com', up: 100, down: 200, 'skip-cert-verify': true },
    })
  })

  it('never inherits external providers, local files, scripts or node extension fields', () => {
    const profile = parseClashAccelerationProfile(source({
      'proxy-providers': { remote: { type: 'http', url: 'https://example.com/subscription-token', path: 'C:/private/provider.yaml' } },
      'rule-providers': { file: { type: 'file', path: 'C:/private/rules.yaml' } },
      script: { code: 'untrusted code' },
      'external-ui': 'C:/private/ui',
    }, {
      'client-certificate': 'C:/private/cert.pem',
      'client-key': 'C:/private/key.pem',
      'interface-name': 'untrusted-interface',
      'routing-mark': 10,
      extra: { password: 'not-imported' },
    }))
    const serialized = JSON.stringify(profile)
    expect(serialized).not.toContain('C:/private')
    expect(serialized).not.toContain('subscription-token')
    expect(serialized).not.toContain('untrusted')
    expect(serialized).not.toContain('not-imported')
  })

  it('counts unsupported protocols and changed transports without importing them', () => {
    const data = parse(source())
    data.proxies.unshift({ type: 'ss', password: 'unsupported-secret' })
    data.proxies.push({ type: 'hysteria2', 'dialer-proxy': 'unsafe-chain' })
    const profile = parseClashAccelerationProfile(stringify(data))
    expect(profile).toMatchObject({ sourceNodeCount: 3, unsupportedNodeCount: 2 })
    expect(profile.nodes.map((node) => node.id)).toEqual(['line-2'])
    expect(JSON.stringify(profile)).not.toContain('unsupported-secret')
  })

  it('removes subscription metadata entries and deduplicates identical connections', () => {
    const data = parse(source())
    data.proxies.unshift({ ...data.proxies[0], name: '剩余流量：100 GB' })
    data.proxies.push({ ...data.proxies[1], name: '套餐到期：2099-01-01' })
    data.proxies.push({ ...data.proxies[1], name: 'Renamed duplicate' })
    data.proxies.push({ ...data.proxies[1], name: 'Different credential', password: 'separate-test-password' })
    data.proxies.push({ ...data.proxies[1], name: '距离下次重置剩余：30 天' })
    const profile = parseClashAccelerationProfile(stringify(data))
    expect(profile).toMatchObject({ sourceNodeCount: 6, metadataNodeCount: 3, duplicateNodeCount: 1, insecureTlsNodeCount: 2 })
    expect(profile.nodes.map((node) => node.id)).toEqual(['line-2', 'line-5'])
    expect(JSON.stringify(profile)).not.toContain('2099-01-01')
  })

  it('returns fixed region labels instead of copying arbitrary source node names', () => {
    const profile = parseClashAccelerationProfile(source({}, { name: '🇭🇰香港 节点 example.com/private-token' }))
    expect(profile.nodes[0]).toMatchObject({ label: '香港线路 1', region: 'HK' })
    expect(JSON.stringify(profile)).not.toContain('private-token')
  })

  it('does not read provider-only profiles or return a fake usable line', () => {
    expect(() => parseClashAccelerationProfile('proxy-providers: {remote: {type: http}}')).toThrow('内联节点')
    expect(() => parseClashAccelerationProfile(source({ proxies: [{ type: 'vmess' }] }))).toThrow('没有可用节点')
  })

  it('rejects aliases, duplicate keys and custom tags without reflecting source lines', () => {
    for (const yaml of [
      'private: &secret credential-value\nproxies: [*secret]',
      'password: credential-value\npassword: other',
      'proxies: !custom credential-value',
      'password: [credential-value',
    ]) {
      try {
        parseClashAccelerationProfile(yaml)
        expect.fail('Expected invalid YAML to be rejected')
      } catch (error) {
        expect(String(error)).not.toContain('credential-value')
        expect(String(error)).toContain('Clash 配置格式无效')
      }
    }
  })

  it('bounds source size and node count before building a profile', () => {
    expect(() => parseClashAccelerationProfile(' '.repeat(MAX_ACCELERATION_CLASH_BYTES + 1))).toThrow('2 MB')
    expect(() => parseClashAccelerationProfile(source({ proxies: Array.from({ length: 513 }, () => ({ type: 'ss' })) }))).toThrow('512')
  })

  it.each([
    ['server', 'https://user:private@node.example.com'],
    ['server', 'C:\\private\\nodes'],
    ['sni', 'tls.example.com/path'],
    ['port', 65536],
    ['port', '443'],
    ['password', { value: 'private' }],
    ['password', 'private\nsecret'],
    ['up', 0],
    ['down', 'file://private'],
    ['skip-cert-verify', 'true'],
  ])('rejects invalid %s fields without revealing their value', (key, value) => {
    expect(() => parseClashAccelerationProfile(source({}, { [key]: value }))).toThrow('加速节点的')
  })

  it('defaults to verifying TLS and supports an IP host and bandwidth units', () => {
    const profile = parseClashAccelerationProfile(source({}, { server: '2001:db8::1', sni: undefined, up: '100 Mbps', 'skip-cert-verify': undefined }))
    expect(profile.insecureTlsNodeCount).toBe(0)
    expect(profile.nodes[0].connection).toMatchObject({ server: '2001:db8::1', up: '100 Mbps', 'skip-cert-verify': false })
    expect(profile.nodes[0].connection).not.toHaveProperty('sni')
  })
})

describe('buildIsolatedMihomoConfig', () => {
  it('replaces imported settings with one loopback-only route and disables TUN', () => {
    const profile = parseClashAccelerationProfile(source({
      'mixed-port': 7890, 'allow-lan': true, 'bind-address': '*',
      'external-controller': '0.0.0.0:9090', secret: 'old-secret',
      tun: { enable: true, 'auto-route': true },
      dns: { enable: true, listen: '0.0.0.0:53' },
      rules: ['MATCH,DIRECT'],
    }, { name: 'DIRECT' }))
    const config = parse(buildIsolatedMihomoConfig(profile, { mixedPort: 27901 }))
    expect(config).toMatchObject({
      'mixed-port': 27901, 'allow-lan': false, 'bind-address': '127.0.0.1', ipv6: false,
      mode: 'rule', tun: { enable: false }, dns: { enable: false }, sniffer: { enable: false },
      'proxy-groups': [{ name: 'XINGMANG', type: 'select', proxies: ['line-1'] }],
      rules: ['MATCH,XINGMANG'],
    })
    expect(config.proxies).toHaveLength(1)
    expect(config.proxies[0].name).toBe('line-1')
    expect(config).not.toHaveProperty('external-controller')
    expect(config).not.toHaveProperty('secret')
    expect(config).not.toHaveProperty('proxy-providers')
    expect(config.tun).not.toHaveProperty('auto-route')
  })

  it('requires a distinct loopback controller port and a strong runtime secret', () => {
    const profile = parseClashAccelerationProfile(source())
    const secret = 'a'.repeat(48)
    const config = parse(buildIsolatedMihomoConfig(profile, { mixedPort: 27901, controllerPort: 27902, controllerSecret: secret }))
    expect(config['external-controller']).toBe('127.0.0.1:27902')
    expect(config.secret).toBe(secret)
    expect(() => buildIsolatedMihomoConfig(profile, { mixedPort: 27901, controllerPort: 27901, controllerSecret: secret })).toThrow('不能相同')
    expect(() => buildIsolatedMihomoConfig(profile, { mixedPort: 27901, controllerPort: 27902 })).toThrow('控制凭据')
    expect(() => buildIsolatedMihomoConfig(profile, { mixedPort: 27901, controllerPort: 27902, controllerSecret: 'weak' })).toThrow('控制凭据')
    expect(() => buildIsolatedMihomoConfig(profile, { mixedPort: 27901, controllerSecret: secret })).toThrow('控制端口未设置')
  })

  it.each([80, 65536, 27901.5, Number.NaN])('rejects invalid runtime ports: %s', (mixedPort) => {
    expect(() => buildIsolatedMihomoConfig(parseClashAccelerationProfile(source()), { mixedPort })).toThrow('本地端口')
  })

  it('allows controller-only diagnostics without opening a proxy listener', () => {
    const profile = parseClashAccelerationProfile(source())
    expect(() => buildIsolatedMihomoConfig(profile, { mixedPort: 0 })).toThrow('必须设置加速内核控制端口')
    const config = parse(buildIsolatedMihomoConfig(profile, { mixedPort: 0, controllerPort: 27902, controllerSecret: 'a'.repeat(48) }))
    expect(config['mixed-port']).toBe(0)
    expect(config['external-controller']).toBe('127.0.0.1:27902')
  })

  it('selects only the requested line and does not allow a missing line to fall back', () => {
    const data = parse(source())
    data.proxies.push({ ...data.proxies[0], name: 'Other line', password: 'other-test-password' })
    const profile = parseClashAccelerationProfile(stringify(data))
    const config = parse(buildIsolatedMihomoConfig(profile, { mixedPort: 27901, nodeId: 'line-2' }))
    expect(config.proxies).toHaveLength(1)
    expect(config.proxies[0].password).toBe('other-test-password')
    expect(() => buildIsolatedMihomoConfig(profile, { mixedPort: 27901, nodeId: 'missing' })).toThrow('线路不存在')
  })

  it('includes all projected nodes for explicit controller probes without automatic health checks', () => {
    const data = parse(source())
    data.proxies.push({ ...data.proxies[0], name: 'Other line', password: 'other-test-password' })
    const profile = parseClashAccelerationProfile(stringify(data))
    const config = parse(buildIsolatedMihomoConfig(profile, { mixedPort: 27901 }))
    expect(config.proxies.map((node: { name: string }) => node.name)).toEqual(['line-1', 'line-2'])
    expect(config['proxy-groups']).toEqual([{ name: 'XINGMANG', type: 'select', proxies: ['line-1', 'line-2'] }])
    expect(config.rules).toEqual(['MATCH,XINGMANG'])
    expect(JSON.stringify(config)).not.toContain('url-test')
    expect(JSON.stringify(config)).not.toContain('health-check')
  })

  it('rejects proxy IDs that collide or try to introduce a reserved route', () => {
    const profile = parseClashAccelerationProfile(source())
    profile.nodes[0].id = 'DIRECT'
    expect(() => buildIsolatedMihomoConfig(profile, { mixedPort: 27901 })).toThrow('线路标识无效')
    profile.nodes[0].id = 'line-1'
    profile.nodes.push({ ...profile.nodes[0] })
    expect(() => buildIsolatedMihomoConfig(profile, { mixedPort: 27901 })).toThrow('线路列表无效')
  })

  it('projects connection fields again instead of trusting a mutated typed profile', () => {
    const profile = parseClashAccelerationProfile(source())
    Object.assign(profile.nodes[0].connection, { 'client-key': 'private.pem', name: 'DIRECT', 'dialer-proxy': 'DIRECT' })
    const config = parse(buildIsolatedMihomoConfig(profile, { mixedPort: 27901 }))
    expect(config.proxies[0]).not.toHaveProperty('client-key')
    expect(config.proxies[0]).not.toHaveProperty('dialer-proxy')
    expect(config.proxies[0].name).toBe('line-1')
  })
})

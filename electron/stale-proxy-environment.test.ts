import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildClearUserProxyScript,
  buildReadProxyScopesScript,
  bypassClosedLoopbackProxies,
  clearStaleUserProxyVariables,
  describeDroppedProxies,
  inspectProxyVariables,
  parseClearUserProxyOutput,
  parseLoopbackProxyTarget,
  parseProxyScopesOutput,
  probeLoopbackProxy,
  withoutClosedProxyVariables,
  type LoopbackProxyTarget,
} from './stale-proxy-environment'

const servers: net.Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
})

async function listeningPort(): Promise<number> {
  const server = net.createServer((socket) => socket.destroy())
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  return address.port
}

async function closedPort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  await new Promise((resolve) => server.close(resolve))
  return address.port
}

function probeFor(openPorts: number[]) {
  const calls: LoopbackProxyTarget[] = []
  const probe = async (target: LoopbackProxyTarget) => {
    calls.push(target)
    return openPorts.includes(target.port)
  }
  return { probe, calls }
}

describe('parseLoopbackProxyTarget', () => {
  it('recognizes loopback proxies with and without a scheme', () => {
    expect(parseLoopbackProxyTarget('http://127.0.0.1:7890')).toEqual({ host: '127.0.0.1', port: 7890 })
    expect(parseLoopbackProxyTarget('127.0.0.1:7890')).toEqual({ host: '127.0.0.1', port: 7890 })
    expect(parseLoopbackProxyTarget(' socks5://LOCALHOST:1080 ')).toEqual({ host: 'localhost', port: 1080 })
    expect(parseLoopbackProxyTarget('http://user:secret@127.0.0.2:8080/')).toEqual({ host: '127.0.0.2', port: 8080 })
    expect(parseLoopbackProxyTarget('http://[::1]:7890')).toEqual({ host: '::1', port: 7890 })
  })

  it('does not guess at remote hosts, missing ports or unreadable values', () => {
    expect(parseLoopbackProxyTarget('http://proxy.corp.example:8080')).toBeNull()
    expect(parseLoopbackProxyTarget('http://10.0.0.5:7890')).toBeNull()
    expect(parseLoopbackProxyTarget('http://127.0.0.1')).toBeNull()
    expect(parseLoopbackProxyTarget('not a url at all')).toBeNull()
    expect(parseLoopbackProxyTarget('')).toBeNull()
    expect(parseLoopbackProxyTarget(undefined)).toBeNull()
  })
})

describe('inspectProxyVariables', () => {
  it('classifies each proxy variable and probes each loopback port once', async () => {
    const { probe, calls } = probeFor([1080])
    const findings = await inspectProxyVariables({
      https_proxy: 'http://127.0.0.1:7890',
      HTTP_PROXY: 'http://127.0.0.1:7890',
      ALL_PROXY: 'socks5://127.0.0.1:1080',
      NO_PROXY: 'localhost',
      PATH: '/usr/bin',
    }, probe)
    expect(findings).toEqual([
      { name: 'HTTP_PROXY', target: { host: '127.0.0.1', port: 7890 }, reach: 'closed' },
      { name: 'HTTPS_PROXY', target: { host: '127.0.0.1', port: 7890 }, reach: 'closed' },
      { name: 'ALL_PROXY', target: { host: '127.0.0.1', port: 1080 }, reach: 'open' },
    ])
    expect(calls).toHaveLength(2)
  })

  it('treats a remote proxy as remote without probing it', async () => {
    const { probe, calls } = probeFor([])
    expect(await inspectProxyVariables({ HTTPS_PROXY: 'http://proxy.corp.example:8080' }, probe))
      .toEqual([{ name: 'HTTPS_PROXY', target: null, reach: 'remote' }])
    expect(calls).toHaveLength(0)
  })

  it('counts a probe that throws as closed', async () => {
    const findings = await inspectProxyVariables({ HTTPS_PROXY: 'http://127.0.0.1:7890' }, async () => { throw new Error('boom') })
    expect(findings[0].reach).toBe('closed')
  })
})

describe('bypassClosedLoopbackProxies', () => {
  it('drops only the variables that point at a closed loopback proxy, in every spelling', async () => {
    const { probe } = probeFor([1080])
    const env = {
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      https_proxy: 'http://127.0.0.1:7890',
      ALL_PROXY: 'socks5://127.0.0.1:1080',
      HTTP_PROXY: 'http://proxy.corp.example:8080',
      NO_PROXY: 'localhost',
      TERM: 'xterm-256color',
    }
    const result = await bypassClosedLoopbackProxies(env, probe)
    expect(result.env).toEqual({
      ALL_PROXY: 'socks5://127.0.0.1:1080',
      HTTP_PROXY: 'http://proxy.corp.example:8080',
      NO_PROXY: 'localhost',
      TERM: 'xterm-256color',
    })
    expect(result.dropped.map((finding) => finding.name)).toEqual(['HTTPS_PROXY'])
    // The caller's environment is never modified in place.
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7890')
  })

  it('returns the same environment when nothing needs dropping', async () => {
    const env = { HTTPS_PROXY: 'http://127.0.0.1:7890' }
    const result = await bypassClosedLoopbackProxies(env, async () => true)
    expect(result.env).toBe(env)
    expect(result.dropped).toEqual([])
  })

  it('logs only names and ports, never the proxy value', () => {
    const detail = describeDroppedProxies([
      { name: 'HTTPS_PROXY', target: { host: '127.0.0.1', port: 7890 }, reach: 'closed' },
      { name: 'HTTP_PROXY', target: { host: '127.0.0.1', port: 7890 }, reach: 'closed' },
    ])
    expect(detail).toEqual({ variables: 'HTTPS_PROXY,HTTP_PROXY', ports: '7890' })
  })

  it('keeps nothing but the closed variables out', () => {
    const env = { HTTPS_PROXY: 'a', ALL_PROXY: 'b' }
    expect(withoutClosedProxyVariables(env, [])).toBe(env)
  })
})

describe('probeLoopbackProxy', () => {
  it('reports a listening port as open and a closed one as closed', async () => {
    expect(await probeLoopbackProxy({ host: '127.0.0.1', port: await listeningPort() })).toBe(true)
    expect(await probeLoopbackProxy({ host: '127.0.0.1', port: await closedPort() })).toBe(false)
    expect(await probeLoopbackProxy({ host: 'localhost', port: await listeningPort() })).toBe(true)
  })
})

describe('Windows proxy scopes', () => {
  it('reads both scopes through a fixed script and keeps only known names', () => {
    const script = buildReadProxyScopesScript()
    expect(script).toContain('"User"')
    expect(script).toContain('"Machine"')
    expect(parseProxyScopesOutput('noise\n{"user":{"HTTPS_PROXY":"http://127.0.0.1:7890","PATH":"x"},"machine":{}}\n'))
      .toEqual({ user: { HTTPS_PROXY: 'http://127.0.0.1:7890' }, machine: {} })
    expect(() => parseProxyScopesOutput('')).toThrow('没能读到电脑里的代理设置')
  })

  it('passes the names to clear through the environment, never into the script', () => {
    const script = buildClearUserProxyScript()
    expect(script).toContain('$env:XINGMANG_CLEAR_PROXY')
    expect(script).toContain('"User"')
    expect(script).not.toContain('"Machine"')
    expect(parseClearUserProxyOutput('cleared:HTTPS_PROXY;PATH;http_proxy')).toEqual(['HTTPS_PROXY', 'HTTP_PROXY'])
    expect(parseClearUserProxyOutput('cleared:')).toEqual([])
    expect(() => parseClearUserProxyOutput('')).toThrow('没能确认')
  })
})

describe('clearStaleUserProxyVariables', () => {
  function runner(scopes: { user: Record<string, string>; machine: Record<string, string> }) {
    const calls: Array<{ script: string; env: NodeJS.ProcessEnv }> = []
    const run = async (script: string, env: NodeJS.ProcessEnv) => {
      calls.push({ script, env })
      if (script.includes('XINGMANG_CLEAR_PROXY')) return `cleared:${env.XINGMANG_CLEAR_PROXY ?? ''}`
      return JSON.stringify(scopes)
    }
    return { run, calls }
  }

  it('clears only the current user entries that point at a closed loopback proxy', async () => {
    const { run, calls } = runner({
      user: { HTTPS_PROXY: 'http://127.0.0.1:7890', HTTP_PROXY: 'http://127.0.0.1:1080', ALL_PROXY: 'http://proxy.corp.example:8080' },
      machine: {},
    })
    const processEnv: NodeJS.ProcessEnv = { HTTPS_PROXY: 'http://127.0.0.1:7890', HTTP_PROXY: 'http://127.0.0.1:1080' }
    const result = await clearStaleUserProxyVariables({ platform: 'win32', run, probe: probeFor([1080]).probe, processEnv })
    expect(result).toEqual({ cleared: ['HTTPS_PROXY'], machineRemaining: false })
    expect(calls[1].env.XINGMANG_CLEAR_PROXY).toBe('HTTPS_PROXY')
    expect(processEnv).toEqual({ HTTP_PROXY: 'http://127.0.0.1:1080' })
  })

  it('leaves the machine-wide copy alone and says it is still there', async () => {
    const { run, calls } = runner({
      user: { HTTPS_PROXY: 'http://127.0.0.1:7890' },
      machine: { HTTPS_PROXY: 'http://127.0.0.1:7891' },
    })
    const processEnv: NodeJS.ProcessEnv = { HTTPS_PROXY: 'http://127.0.0.1:7890' }
    const result = await clearStaleUserProxyVariables({ platform: 'win32', run, probe: probeFor([]).probe, processEnv })
    expect(result).toEqual({ cleared: ['HTTPS_PROXY'], machineRemaining: true })
    expect(calls).toHaveLength(2)
    // New terminals now inherit the machine value, so this process mirrors it.
    expect(processEnv.HTTPS_PROXY).toBe('http://127.0.0.1:7891')
  })

  it('does not run the clear script when nothing qualifies', async () => {
    const { run, calls } = runner({ user: { HTTPS_PROXY: 'http://127.0.0.1:7890' }, machine: {} })
    const result = await clearStaleUserProxyVariables({ platform: 'win32', run, probe: probeFor([7890]).probe, processEnv: {} })
    expect(result).toEqual({ cleared: [], machineRemaining: false })
    expect(calls).toHaveLength(1)
  })

  it('refuses outside Windows', async () => {
    await expect(clearStaleUserProxyVariables({ platform: 'darwin' })).rejects.toThrow('只有 Windows')
  })
})

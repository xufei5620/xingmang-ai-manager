import { EventEmitter } from 'node:events'
import type https from 'node:https'
import { Readable } from 'node:stream'
import tls from 'node:tls'
import { describe, expect, it } from 'vitest'
import {
  chainEndsOutsideBundledRoots,
  describePeerCertificate,
  environmentProxyCandidates,
  probeToolPathDirect,
  probeToolPathThroughFetch,
  toolPathFailureCounted,
  toolPathFailureKind,
  toolPathOrigins,
  toolPathPassingLines,
  toolPathTlsRejected,
  type ToolPathCertificateTarget,
  type ToolPathResult,
} from './tool-path-probe'

// RFC 5737 / RFC 3849 documentation addresses only.
const v4 = '192.0.2.10'
const v4b = '198.51.100.20'
const v6 = '2001:db8::10'
const fingerprint = Array.from({ length: 32 }, (_, index) => index.toString(16).padStart(2, '0').toUpperCase()).join(':')

type Behavior =
  | { kind: 'respond'; status?: number; body?: string; chunks?: string[]; hang?: boolean; certificate?: unknown }
  | { kind: 'error'; code: string; delayMs?: number }
  | { kind: 'hang' }

interface RecordedRequest {
  options: Record<string, unknown>
  aborted: () => boolean
}

function codedError(code: string): Error {
  return Object.assign(new Error(code), { code })
}

function fakeRequest(behaviors: Record<string, Behavior>, recorded: RecordedRequest[] = []): typeof https.request {
  function request(options: Record<string, unknown>, callback: (response: unknown) => void) {
    const emitter = new EventEmitter()
    const signal = options.signal as AbortSignal | undefined
    recorded.push({ options, aborted: () => signal?.aborted === true })
    const behavior = behaviors[String(options.host)] ?? { kind: 'hang' }
    let response: Readable | null = null
    signal?.addEventListener('abort', () => {
      const error = Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORT_ERR' })
      if (response) response.destroy(error)
      else emitter.emit('error', error)
    }, { once: true })
    function end() {
      if (behavior.kind === 'hang') return
      if (behavior.kind === 'error') {
        setTimeout(() => emitter.emit('error', codedError(behavior.code)), behavior.delayMs ?? 0)
        return
      }
      setTimeout(() => {
        const chunks = behavior.chunks ?? [behavior.body ?? '{"success":true}']
        response = behavior.hang
          ? new Readable({ read() { /* never ends */ } })
          : Readable.from(chunks.map((chunk) => Buffer.from(chunk)))
        if (behavior.hang) response.push(Buffer.from('{"succ'))
        Object.assign(response, {
          statusCode: behavior.status ?? 200,
          socket: { getPeerCertificate: () => behavior.certificate ?? {} },
        })
        callback(response)
      }, 0)
    }
    return Object.assign(emitter, { end })
  }
  return request as unknown as typeof https.request
}

function lookupOf(entries: { address: string; family: number }[]) {
  return async () => entries
}

const [directOrigin, primaryOrigin] = toolPathOrigins()

describe('tool-path-probe', () => {
  it('only probes the xm account line origins', async () => {
    expect(toolPathOrigins()).toHaveLength(2)
    expect(primaryOrigin).toMatch(/^https:\/\//)
    await expect(probeToolPathDirect('https://example.com', { lookup: lookupOf([{ address: v4, family: 4 }]) }))
      .rejects.toThrow('只探测星芒账号自己的线路')
    await expect(probeToolPathDirect(`${directOrigin}/api`, { lookup: lookupOf([{ address: v4, family: 4 }]) }))
      .rejects.toThrow('只探测星芒账号自己的线路')
    await expect(probeToolPathThroughFetch(fetch, 'http://example.com')).rejects.toThrow('只探测星芒账号自己的线路')
  })

  it('connects to the resolved address with the real hostname for SNI and Host', async () => {
    const recorded: RecordedRequest[] = []
    const result = await probeToolPathDirect(directOrigin, {
      lookup: lookupOf([{ address: v4, family: 4 }]),
      request: fakeRequest({ [v4]: { kind: 'respond' } }, recorded),
    })
    expect(result).toMatchObject({ ok: true, addresses: [v4] })
    expect(result.intercepted).toBeUndefined()
    const options = recorded[0].options
    const hostname = new URL(directOrigin).hostname
    expect(options).toMatchObject({ host: v4, family: 4, path: '/api/status', method: 'GET', servername: hostname, agent: false })
    expect(options.headers).toMatchObject({ Host: hostname })
    expect(options.ca).toEqual(expect.arrayContaining([...tls.rootCertificates]))
  })

  it('starts the next address after the stagger delay and cancels the loser once one succeeds', async () => {
    const recorded: RecordedRequest[] = []
    const result = await probeToolPathDirect(directOrigin, {
      lookup: lookupOf([{ address: v6, family: 6 }, { address: v4, family: 4 }]),
      request: fakeRequest({ [v6]: { kind: 'hang' }, [v4]: { kind: 'respond' } }, recorded),
      staggerMs: 10,
    })
    expect(result.ok).toBe(true)
    expect(result.addresses).toEqual([v6, v4])
    expect(recorded.map((entry) => entry.options.host)).toEqual([v6, v4])
    expect(recorded[0].options.family).toBe(6)
    expect(recorded[0].aborted()).toBe(true)
  })

  it('moves on immediately when an address fails before the stagger delay', async () => {
    const started = Date.now()
    const result = await probeToolPathDirect(directOrigin, {
      lookup: lookupOf([{ address: v4b, family: 4 }, { address: v4, family: 4 }]),
      request: fakeRequest({ [v4b]: { kind: 'error', code: 'ECONNREFUSED' }, [v4]: { kind: 'respond' } }),
      staggerMs: 5_000,
    })
    expect(result.ok).toBe(true)
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(result.attempts.map((attempt) => [attempt.address, attempt.ok, attempt.kind])).toEqual([
      [v4b, false, 'refused'],
      [v4, true, undefined],
    ])
  })

  it('reports the most telling failure when every address fails', async () => {
    const inspected: ToolPathCertificateTarget[] = []
    const result = await probeToolPathDirect(directOrigin, {
      lookup: lookupOf([{ address: v4b, family: 4 }, { address: v4, family: 4 }]),
      request: fakeRequest({
        [v4b]: { kind: 'error', code: 'ECONNREFUSED' },
        [v4]: { kind: 'error', code: 'ERR_TLS_CERT_ALTNAME_INVALID', delayMs: 5 },
      }),
      inspectCertificate: async (target) => {
        inspected.push(target)
        return null
      },
      staggerMs: 1,
    })
    expect(result).toMatchObject({ ok: false, kind: 'certificate', addresses: [v4b, v4] })
    expect(result.certificates).toBeUndefined()
    expect(toolPathFailureCounted(result)).toBe(true)
    expect(toolPathTlsRejected(result)).toBe(true)
    // Only the address whose certificate was rejected is looked at again, under the real name.
    expect(inspected.map(({ address, port, servername }) => ({ address, port, servername })))
      .toEqual([{ address: v4, port: 443, servername: new URL(directOrigin).hostname }])
    expect(inspected[0].ca).toEqual(expect.arrayContaining([...tls.rootCertificates]))
  })

  it('records the certificate each rejected address presented without touching the verdict', async () => {
    const presented = { issuer: 'CN=Some Firewall CA', subject: 'CN=xm-direct.solov.cc', fingerprint256: fingerprint, verifyError: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' }
    const result = await probeToolPathDirect(directOrigin, {
      lookup: lookupOf([{ address: v4b, family: 4 }, { address: v4, family: 4 }]),
      request: fakeRequest({
        [v4b]: { kind: 'error', code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' },
        [v4]: { kind: 'error', code: 'SELF_SIGNED_CERT_IN_CHAIN' },
      }),
      inspectCertificate: async (target) => target.address === v4b ? { address: target.address, ...presented } : null,
      staggerMs: 1,
    })
    expect(result).toMatchObject({ ok: false, kind: 'certificate', certificates: [{ address: v4b, ...presented }] })

    const broken = await probeToolPathDirect(directOrigin, {
      lookup: lookupOf([{ address: v4, family: 4 }]),
      request: fakeRequest({ [v4]: { kind: 'error', code: 'CERT_HAS_EXPIRED' } }),
      inspectCertificate: async () => { throw new Error('socket hang up') },
    })
    expect(broken).toMatchObject({ ok: false, kind: 'certificate' })
    expect(broken.certificates).toBeUndefined()

    let looked = false
    const reset = await probeToolPathDirect(directOrigin, {
      lookup: lookupOf([{ address: v4, family: 4 }]),
      request: fakeRequest({ [v4]: { kind: 'error', code: 'ECONNRESET' } }),
      inspectCertificate: async () => {
        looked = true
        return null
      },
    })
    expect(reset).toMatchObject({ ok: false, kind: 'reset' })
    expect(looked).toBe(false)
  })

  it('cleans what the far end wrote into its certificate before it reaches the report', () => {
    const described = describePeerCertificate(v4, {
      issuer: { CN: 'Fake\nRoot\u0007', O: ['Firewall', 'Inc'] },
      subject: { CN: `xm-direct.solov.cc${'x'.repeat(400)}` },
      fingerprint256: fingerprint.toLowerCase(),
    } as unknown as tls.PeerCertificate, 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY')
    expect(described).toMatchObject({ address: v4, issuer: 'CN=Fake Root, O=Firewall / Inc', fingerprint256: fingerprint, verifyError: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' })
    expect(described?.subject.length).toBeLessThanOrEqual(200)
    expect(describePeerCertificate(v4, { fingerprint256: fingerprint } as unknown as tls.PeerCertificate, null)?.verifyError).toBeNull()
    expect(describePeerCertificate(v4, { fingerprint256: fingerprint } as unknown as tls.PeerCertificate, codedError('CERT_UNTRUSTED'))?.verifyError).toBe('CERT_UNTRUSTED')
    expect(describePeerCertificate(v4, { fingerprint256: 'not a fingerprint' } as unknown as tls.PeerCertificate, null)).toBeNull()
    expect(describePeerCertificate(v4, null, null)).toBeNull()
  })

  it('treats a non-200 status or a body without success as an http failure', async () => {
    const gateway = await probeToolPathDirect(directOrigin, {
      lookup: lookupOf([{ address: v4, family: 4 }]),
      request: fakeRequest({ [v4]: { kind: 'respond', status: 502, body: 'bad gateway' } }),
    })
    expect(gateway).toMatchObject({ ok: false, kind: 'http' })
    const page = await probeToolPathDirect(directOrigin, {
      lookup: lookupOf([{ address: v4, family: 4 }]),
      request: fakeRequest({ [v4]: { kind: 'respond', body: '<html>maintenance</html>' } }),
    })
    expect(page).toMatchObject({ ok: false, kind: 'http' })
    const unsuccessful = await probeToolPathDirect(directOrigin, {
      lookup: lookupOf([{ address: v4, family: 4 }]),
      request: fakeRequest({ [v4]: { kind: 'respond', body: '{"success":false}' } }),
    })
    expect(unsuccessful).toMatchObject({ ok: false, kind: 'http' })
    expect(toolPathTlsRejected(unsuccessful)).toBe(false)
  })

  it('rejects a status body over the size cap', async () => {
    const result = await probeToolPathDirect(directOrigin, {
      lookup: lookupOf([{ address: v4, family: 4 }]),
      request: fakeRequest({ [v4]: { kind: 'respond', chunks: ['{"success":true,"pad":"', 'x'.repeat(17 * 1024), '"}'] } }),
    })
    expect(result).toMatchObject({ ok: false, kind: 'http' })
    expect(toolPathTlsRejected(result)).toBe(false)
  })

  it('keeps a hanging resolver inside the total time budget', async () => {
    const started = Date.now()
    const result = await probeToolPathDirect(directOrigin, {
      lookup: () => new Promise(() => undefined),
      request: fakeRequest({}),
      timeoutMs: 50,
    })
    expect(result).toEqual({ ok: false, kind: 'timeout', addresses: [], attempts: [] })
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('does not count a response that is still arriving at the deadline as a failure', async () => {
    const result = await probeToolPathDirect(directOrigin, {
      lookup: lookupOf([{ address: v4, family: 4 }]),
      request: fakeRequest({ [v4]: { kind: 'respond', hang: true } }),
      timeoutMs: 50,
    })
    expect(result).toMatchObject({ ok: false, kind: 'slow' })
    expect(toolPathFailureCounted(result)).toBe(false)
  })

  it('counts a connection that never answers as a timeout', async () => {
    const result = await probeToolPathDirect(directOrigin, {
      lookup: lookupOf([{ address: v4, family: 4 }]),
      request: fakeRequest({ [v4]: { kind: 'hang' } }),
      timeoutMs: 50,
    })
    expect(result).toMatchObject({ ok: false, kind: 'timeout' })
    expect(toolPathFailureCounted(result)).toBe(true)
    expect(toolPathTlsRejected(result)).toBe(false)
  })

  it('reports a resolver failure as dns without any addresses', async () => {
    const result = await probeToolPathDirect(directOrigin, {
      lookup: async () => { throw codedError('ENOTFOUND') },
      request: fakeRequest({}),
    })
    expect(result).toEqual({ ok: false, kind: 'dns', addresses: [], attempts: [] })
    const empty = await probeToolPathDirect(directOrigin, { lookup: lookupOf([]), request: fakeRequest({}) })
    expect(empty).toMatchObject({ ok: false, kind: 'dns' })
  })

  it('flags a pass that only verified through a root outside the bundled store', async () => {
    const root = { fingerprint256: 'AA:01' }
    Object.assign(root, { issuerCertificate: root })
    const leaf = { fingerprint256: 'AA:02', issuerCertificate: root }
    const result = await probeToolPathDirect(directOrigin, {
      lookup: lookupOf([{ address: v4, family: 4 }]),
      request: fakeRequest({ [v4]: { kind: 'respond', certificate: leaf } }),
    })
    expect(result).toMatchObject({ ok: true, intercepted: true })
    expect(chainEndsOutsideBundledRoots(leaf as unknown as tls.PeerCertificate, new Set(['AA:01']))).toBe(false)
    expect(chainEndsOutsideBundledRoots(leaf as unknown as tls.PeerCertificate, new Set(['BB:01']))).toBe(true)
    expect(chainEndsOutsideBundledRoots(null, new Set())).toBe(false)
  })

  it('maps connection error codes to failure kinds', () => {
    expect(toolPathFailureKind(codedError('EAI_AGAIN'))).toBe('dns')
    expect(toolPathFailureKind(codedError('EHOSTUNREACH'))).toBe('refused')
    expect(toolPathFailureKind(codedError('ETIMEDOUT'))).toBe('timeout')
    expect(toolPathFailureKind(codedError('SELF_SIGNED_CERT_IN_CHAIN'))).toBe('certificate')
    expect(toolPathFailureKind(codedError('CERT_HAS_EXPIRED'))).toBe('certificate')
    expect(toolPathFailureKind(codedError('EPROTO'))).toBe('tls')
    expect(toolPathFailureKind(codedError('ECONNRESET'))).toBe('reset')
    expect(toolPathFailureKind(new Error('no code'))).toBe('reset')
  })

  it('judges a proxied probe the same way and never follows redirects', async () => {
    const calls: RequestInit[] = []
    function fetchReturning(response: Response): typeof fetch {
      return async (_input, init) => {
        calls.push(init ?? {})
        return response
      }
    }
    expect(await probeToolPathThroughFetch(fetchReturning(new Response('{"success":true}')), primaryOrigin)).toMatchObject({ ok: true })
    expect(calls[0]).toMatchObject({ redirect: 'manual', credentials: 'omit' })
    expect(await probeToolPathThroughFetch(fetchReturning(new Response('', { status: 302 })), primaryOrigin)).toMatchObject({ ok: false, kind: 'http' })
    expect(await probeToolPathThroughFetch(fetchReturning(new Response('{"success":false}')), primaryOrigin)).toMatchObject({ ok: false, kind: 'http' })
    const oversized = new Response(`{"success":true,"pad":"${'x'.repeat(17 * 1024)}"}`)
    expect(await probeToolPathThroughFetch(fetchReturning(oversized), primaryOrigin)).toMatchObject({ ok: false, kind: 'http' })
    // Like a real fetch, the body errors once the request signal fires.
    const trickle: typeof fetch = async (_input, init) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"succ'))
        init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true })
      },
    }))
    expect(await probeToolPathThroughFetch(trickle, primaryOrigin, 50)).toMatchObject({ ok: false, kind: 'slow' })
    const failing: typeof fetch = async () => { throw new TypeError('fetch failed', { cause: codedError('ECONNREFUSED') }) }
    expect(await probeToolPathThroughFetch(failing, primaryOrigin)).toMatchObject({ ok: false })
  })

  // 经代理时握手被掐断，和不经代理那条一样算 tls（工具线路说成连接被重置），不算证书错误（#1060）。
  it('keeps a cut handshake through a proxy apart from a certificate failure', async () => {
    function failingWith(message: string): typeof fetch {
      return async () => { throw new TypeError('fetch failed', { cause: new Error(message) }) }
    }
    expect(await probeToolPathThroughFetch(failingWith('net::ERR_SSL_PROTOCOL_ERROR'), primaryOrigin)).toMatchObject({ ok: false, kind: 'tls' })
    expect(await probeToolPathThroughFetch(failingWith('net::ERR_QUIC_HANDSHAKE_FAILED'), primaryOrigin)).toMatchObject({ ok: false, kind: 'tls' })
    expect(await probeToolPathThroughFetch(failingWith('net::ERR_CERT_AUTHORITY_INVALID'), primaryOrigin)).toMatchObject({ ok: false, kind: 'certificate' })
    expect(await probeToolPathThroughFetch(failingWith('net::ERR_CONNECTION_RESET'), primaryOrigin)).toMatchObject({ ok: false, kind: 'refused' })
  })

  it('prefers lines that pass on every path and falls back to the direct path', () => {
    function result(ok: boolean): ToolPathResult {
      return ok ? { ok, addresses: [], attempts: [] } : { ok, kind: 'timeout', addresses: [], attempts: [] }
    }
    expect(toolPathPassingLines({
      direct: { direct: result(true), systemProxy: result(false) },
      primary: { direct: result(true), systemProxy: result(true) },
    })).toEqual(['primary'])
    expect(toolPathPassingLines({
      direct: { direct: result(true), systemProxy: result(false) },
      primary: { direct: result(false), systemProxy: result(false) },
    })).toEqual(['direct'])
    expect(toolPathPassingLines({ direct: { direct: result(false) }, primary: { direct: result(false) } })).toEqual([])
  })

  it('collects proxy variables from every scope without credentials or duplicates', () => {
    expect(environmentProxyCandidates({
      process: { https_proxy: 'http://user:secret@127.0.0.1:7890', ALL_PROXY: 'socks5://127.0.0.1:7891' },
      user: { HTTPS_PROXY: '127.0.0.1:7890' },
      machine: { HTTPS_PROXY: 'ftp://127.0.0.1:21', ALL_PROXY: 'not a url ::' },
    })).toEqual(['socks5://127.0.0.1:7891', 'http://127.0.0.1:7890'])
    expect(environmentProxyCandidates({ process: { HTTPS_PROXY: '  ' } })).toEqual([])
    // 带用户名密码的测不了，跳过，不拿去掉密码的地址冒充。
    expect(environmentProxyCandidates({ process: { HTTPS_PROXY: 'http://user:secret@127.0.0.1:7890' } })).toEqual([])
  })
})

import dns from 'node:dns'
import https from 'node:https'
import type { IncomingMessage } from 'node:http'
import tls, { type PeerCertificate, type TLSSocket } from 'node:tls'
import { X509Certificate } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { readBoundedResponseText } from './bounded-response'
import { classifyNetworkFailure } from './network-failure'
import { relayEndpointOrigin } from './relay-sites'
import type { StaleProxyVariableName } from './stale-proxy-environment'

/**
 * 「工具同路径」探测（xm 三线路 C4，需求 5.1.1）：照 AI 工具自己连星芒的样子查一条线路通不通。
 * Claude Code、Gemini、Grok 这些命令行工具跑在 Node 里，不走 Chromium，所以不能拿 main.ts 那个
 * Chromium 探测的结果去替它们定线路：两边的 DNS、证书、HTTP 版本都可能不一样。
 *
 * 无代理路径：系统解析出全部地址，按顺序每隔 250 毫秒起一个连接（Happy Eyeballs），任一地址握手
 * 成功、在同一条连接上 GET /api/status 回 200 且 JSON 里 success 为 true，就算通。证书同时信 Node
 * 自带的根证书和系统根证书：只靠系统根证书才过的照样算通，标成「安全软件接管」（intercepted）。
 * 不起子进程，不改任何设置。照 I10：总时限 10 秒、正文 16KB 上限、不跟重定向、只去本站线路的 origin。
 *
 * 代理路径（系统代理、HTTPS_PROXY / ALL_PROXY）由调用方拿 Chromium 会话去测（probeToolPathThroughFetch），
 * 这里只负责判结果和挑出要测的代理。
 */

/**
 * 没走通的原因。slow = 已经收到响应头、正文还在来，只是没在时限里收完：不算线路坏了（需求 5.1.1
 * 「慢但有进展不算失败」）。其余都算一次连接级失败。http = 握手过了、证书是星芒的，回的却不是
 * 200 的 JSON（网关 502、跳转）：工具连过去也一样用不了，所以也算。
 */
export type ToolPathFailureKind = 'dns' | 'refused' | 'reset' | 'timeout' | 'certificate' | 'tls' | 'http' | 'slow'

export interface ToolPathAttempt {
  address: string
  family: 4 | 6
  ok: boolean
  kind?: ToolPathFailureKind
  intercepted?: boolean
  durationMs: number
}

export interface ToolPathResult {
  ok: boolean
  kind?: ToolPathFailureKind
  /** 只靠系统根证书才过：本机的安全软件在接管 HTTPS。 */
  intercepted?: boolean
  /** 系统解析出来的全部地址，给失败归类用（route-failure-classifier.ts）；日志里不记。 */
  addresses: string[]
  attempts: ToolPathAttempt[]
}

export const toolPathTimeoutMs = 10_000
const toolPathStaggerMs = 250
const maximumStatusBytes = 16 * 1024

/** 这次失败要不要记进连败次数。 */
export function toolPathFailureCounted(result: Pick<ToolPathResult, 'ok' | 'kind'>): boolean {
  return !result.ok && result.kind !== 'slow'
}

/** 握手因为证书或 TLS 没过：失败归类判「劫持」的条件之一。 */
export function toolPathTlsRejected(result: Pick<ToolPathResult, 'ok' | 'kind'>): boolean {
  return !result.ok && (result.kind === 'certificate' || result.kind === 'tls' || result.kind === 'reset')
}

/** 这几个 origin 之外一律不探：地址只从 relay-sites.ts 里来。 */
export function toolPathOrigins(): string[] {
  return (['direct', 'primary'] as const).map((line) => relayEndpointOrigin('solov', line)).filter((origin): origin is string => origin !== null)
}

function assertToolPathOrigin(origin: string): URL {
  const url = new URL(origin)
  if (url.protocol !== 'https:' || url.origin !== origin || !toolPathOrigins().includes(origin)) {
    throw new Error('只探测星芒账号自己的线路')
  }
  return url
}

const certificateCodes = new Set([
  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'CERT_UNTRUSTED', 'CERT_REJECTED', 'CERT_SIGNATURE_FAILURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'HOSTNAME_MISMATCH',
])

/** 一个连接错误算哪一类。 */
export function toolPathFailureKind(error: unknown): ToolPathFailureKind {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : ''
  if (certificateCodes.has(code) || code.startsWith('CERT_')) return 'certificate'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_FAIL' || code === 'EAI_NODATA') return 'dns'
  if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'EADDRNOTAVAIL') return 'refused'
  if (code === 'ETIMEDOUT' || code === 'ABORT_ERR' || code === 'UND_ERR_CONNECT_TIMEOUT') return 'timeout'
  if (code === 'EPROTO' || code.startsWith('ERR_SSL_') || code.startsWith('ERR_TLS_')) return 'tls'
  return 'reset'
}

// Node 自带的根证书、加上这台电脑系统里的根证书（Windows 证书库、macOS 钥匙串）。读系统那份是同步
// 调用，Linux 上实测就要四五十毫秒，Windows 要枚举证书库只会更久，所以放进一个用完就退的 worker 线程
// 里读，不卡主进程；第一次探测时才读，整个运行只读一次。拿不到就只用自带的。
const systemCertificatesWorkerSource = `
const { parentPort } = require('node:worker_threads')
const tls = require('node:tls')
let certificates = []
try { certificates = typeof tls.getCACertificates === 'function' ? tls.getCACertificates('system') : [] } catch {}
parentPort.postMessage(certificates)
`
let trustedCertificates: Promise<string[]> | null = null
let bundledRootFingerprints: Set<string> | null = null

function readSystemCertificates(): Promise<string[]> {
  return new Promise((resolve) => {
    let worker: Worker
    try {
      worker = new Worker(systemCertificatesWorkerSource, { eval: true })
    } catch {
      resolve([])
      return
    }
    worker.once('message', (value: unknown) => {
      resolve(Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [])
      void worker.terminate()
    })
    worker.once('error', () => resolve([]))
    worker.once('exit', () => resolve([]))
  })
}

function caCertificates(): Promise<string[]> {
  trustedCertificates ??= readSystemCertificates().then((system) => [...new Set([...tls.rootCertificates, ...system])])
  return trustedCertificates
}

function bundledFingerprints(): Set<string> {
  if (bundledRootFingerprints) return bundledRootFingerprints
  const fingerprints = new Set<string>()
  for (const pem of tls.rootCertificates) {
    try { fingerprints.add(new X509Certificate(pem).fingerprint256) } catch { /* 认不出的跳过 */ }
  }
  bundledRootFingerprints = fingerprints
  return fingerprints
}

/** 验过的证书链最顶上那张不是 Node 自带的根证书：是系统里另装的（多半是安全软件的）。 */
export function chainEndsOutsideBundledRoots(certificate: PeerCertificate | null | undefined, bundled: ReadonlySet<string> = bundledFingerprints()): boolean {
  let current = certificate && 'fingerprint256' in certificate ? certificate as tls.DetailedPeerCertificate : null
  const seen = new Set<string>()
  while (current?.issuerCertificate && current.issuerCertificate !== current && !seen.has(current.fingerprint256)) {
    seen.add(current.fingerprint256)
    current = current.issuerCertificate
  }
  return current !== null && Boolean(current.fingerprint256) && !bundled.has(current.fingerprint256)
}

export interface ToolPathProbeDependencies {
  /** 缺省 dns.promises.lookup(all)。 */
  lookup?(hostname: string): Promise<{ address: string; family: number }[]>
  /** 缺省 https.request；测试注入用。 */
  request?: typeof https.request
  timeoutMs?: number
  staggerMs?: number
}

function statusBodySucceeded(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null && (parsed as { success?: unknown }).success === true
  } catch {
    return false
  }
}

// 直接读 Node 的响应流，不转成 Web 流：中途被总时限掐断时，转换层会在流关掉之后还往里塞数据、
// 抛出没人接的异常。超过上限立刻断开。
function readBoundedBody(response: IncomingMessage, maximumBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let received = 0
    response.on('data', (chunk: Buffer) => {
      received += chunk.byteLength
      if (received > maximumBytes) {
        response.destroy(new Error(`线路探测响应超过 ${Math.floor(maximumBytes / 1024)} KB 安全上限`))
        return
      }
      chunks.push(chunk)
    })
    response.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    response.on('error', reject)
    response.once('close', () => {
      if (!response.readableEnded) reject(new Error('线路探测响应没收完'))
    })
  })
}

interface AttemptContext {
  url: URL
  request: typeof https.request
  signal: AbortSignal
  ca: string[]
}

function attempt(context: AttemptContext, address: string, family: 4 | 6): Promise<ToolPathAttempt> {
  const started = Date.now()
  return new Promise((resolve) => {
    let headers = false
    let settled = false
    function finish(result: Omit<ToolPathAttempt, 'address' | 'family' | 'durationMs'>): void {
      if (settled) return
      settled = true
      resolve({ address, family, durationMs: Date.now() - started, ...result })
    }
    const request = context.request({
      host: address,
      family,
      port: Number(context.url.port || 443),
      path: '/api/status',
      method: 'GET',
      servername: context.url.hostname,
      headers: { Host: context.url.host, Accept: 'application/json', Connection: 'close' },
      agent: false,
      ca: context.ca,
      signal: context.signal,
    }, (response: IncomingMessage) => {
      headers = true
      const status = response.statusCode ?? 0
      const intercepted = chainEndsOutsideBundledRoots((response.socket as TLSSocket).getPeerCertificate?.(true))
      if (status !== 200) {
        response.on('error', () => undefined)
        response.destroy()
        finish({ ok: false, kind: 'http' })
        return
      }
      void readBoundedBody(response, maximumStatusBytes).then((text) => {
        finish(statusBodySucceeded(text) ? { ok: true, ...(intercepted ? { intercepted: true } : {}) } : { ok: false, kind: 'http' })
      }, () => finish({ ok: false, kind: context.signal.aborted ? 'slow' : 'reset' }))
    })
    request.on('error', (error) => {
      finish({ ok: false, kind: context.signal.aborted ? headers ? 'slow' : 'timeout' : toolPathFailureKind(error) })
    })
    request.end()
  })
}

// 都没通时挑一个最能说明问题的原因：有进展的先说（不算失败），再按证书、TLS、重置……的顺序。
const kindPriority: readonly ToolPathFailureKind[] = ['slow', 'certificate', 'tls', 'reset', 'http', 'timeout', 'refused', 'dns']

/** 无代理路径探一条线路。不抛错：通不通、为什么都在结果里。 */
export async function probeToolPathDirect(origin: string, dependencies: ToolPathProbeDependencies = {}): Promise<ToolPathResult> {
  const url = assertToolPathOrigin(origin)
  const timeoutMs = dependencies.timeoutMs ?? toolPathTimeoutMs
  const staggerMs = dependencies.staggerMs ?? toolPathStaggerMs
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), timeoutMs)
  deadline.unref?.()
  try {
    let resolved: { address: string; family: number }[]
    try {
      resolved = await (dependencies.lookup ?? ((hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true })))(url.hostname)
    } catch (error) {
      return { ok: false, kind: toolPathFailureKind(error) === 'timeout' ? 'timeout' : 'dns', addresses: [], attempts: [] }
    }
    const candidates = resolved.filter((entry) => entry.family === 4 || entry.family === 6)
    const addresses = candidates.map((entry) => entry.address)
    if (!candidates.length) return { ok: false, kind: 'dns', addresses, attempts: [] }
    const context = { url, request: dependencies.request ?? https.request, signal: controller.signal, ca: await caCertificates() }
    const attempts: ToolPathAttempt[] = []
    const winner = await new Promise<ToolPathAttempt | null>((resolve) => {
      let started = 0
      let finished = 0
      let staggerTimer: ReturnType<typeof setTimeout> | null = null
      function startNext(): void {
        if (staggerTimer) clearTimeout(staggerTimer)
        staggerTimer = null
        if (started >= candidates.length) return
        const candidate = candidates[started]
        started += 1
        void attempt(context, candidate.address, candidate.family === 6 ? 6 : 4).then((result) => {
          attempts.push(result)
          finished += 1
          if (result.ok) {
            resolve(result)
            return
          }
          if (finished === candidates.length) resolve(null)
          else if (finished === started) startNext()
        })
        if (started < candidates.length) staggerTimer = setTimeout(startNext, staggerMs)
      }
      startNext()
      controller.signal.addEventListener('abort', () => { if (staggerTimer) clearTimeout(staggerTimer) }, { once: true })
    })
    if (winner) {
      controller.abort()
      return { ok: true, ...(winner.intercepted ? { intercepted: true } : {}), addresses, attempts }
    }
    const kind = kindPriority.find((entry) => attempts.some((item) => item.kind === entry)) ?? 'timeout'
    return { ok: false, kind, addresses, attempts }
  } finally {
    clearTimeout(deadline)
  }
}

/**
 * 经代理（系统代理或 HTTPS_PROXY）探一条线路：fetchImpl 由调用方给，是一个设好了代理的 Chromium
 * 会话的 fetch。判法和无代理路径一样：200、JSON、success 为 true，不跟重定向。
 */
export async function probeToolPathThroughFetch(fetchImpl: typeof fetch, origin: string, timeoutMs = toolPathTimeoutMs): Promise<ToolPathResult> {
  const url = assertToolPathOrigin(origin)
  let response: Response
  try {
    response = await fetchImpl(new URL('/api/status', url).href, {
      method: 'GET',
      credentials: 'omit',
      redirect: 'manual',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const reason = classifyNetworkFailure(error)
    const kind: ToolPathFailureKind = reason === 'dns' ? 'dns' : reason === 'timeout' ? 'timeout' : reason === 'refused' ? 'refused'
      : reason === 'tls' || reason === 'certDate' || reason === 'intercepted' ? 'certificate' : 'reset'
    return { ok: false, kind, addresses: [], attempts: [] }
  }
  if (response.status !== 200 || response.type === 'opaqueredirect') {
    await response.body?.cancel().catch(() => undefined)
    return { ok: false, kind: 'http', addresses: [], attempts: [] }
  }
  try {
    const text = await readBoundedResponseText(response, maximumStatusBytes, '线路探测')
    return statusBodySucceeded(text) ? { ok: true, addresses: [], attempts: [] } : { ok: false, kind: 'http', addresses: [], attempts: [] }
  } catch {
    return { ok: false, kind: 'slow', addresses: [], attempts: [] }
  }
}

export interface ToolPathResults {
  direct: ToolPathResult
  systemProxy?: ToolPathResult
  environmentProxy?: ToolPathResult
}

/** 一条线路在所有在用的路径上都通才算通（需求 5.1.1「判定」）。 */
export function toolPathPassesEverywhere(results: ToolPathResults): boolean {
  return [results.direct, results.systemProxy, results.environmentProxy].every((result) => result === undefined || result.ok)
}

/**
 * 几条线路各自的结果里挑通的：先要所有路径都通；一条都没有，就只看无代理路径（需求 5.1.1：没有一条
 * 线路能在所有路径上都通时，以无代理路径为准）。
 */
export function toolPathPassingLines<T extends string>(results: Partial<Record<T, ToolPathResults>>): T[] {
  const entries = Object.entries(results) as [T, ToolPathResults | undefined][]
  const everywhere = entries.filter(([, result]) => result && toolPathPassesEverywhere(result)).map(([line]) => line)
  return everywhere.length ? everywhere : entries.filter(([, result]) => result?.direct.ok).map(([line]) => line)
}

const proxyVariableOrder: readonly StaleProxyVariableName[] = ['HTTPS_PROXY', 'ALL_PROXY']

function proxyValue(env: Readonly<Record<string, string | undefined>>, name: StaleProxyVariableName): string | undefined {
  const key = Object.keys(env).find((entry) => entry.toUpperCase() === name)
  const value = key === undefined ? undefined : env[key]?.trim()
  return value ? value : undefined
}

/**
 * 要测哪几个环境变量代理：本进程继承来的、当前账号的、整台电脑的（Windows 的 HKCU\Environment 和系统
 * 环境，用 stale-proxy-environment.ts 的 readWindowsProxyScopes 读）。客户新开的终端读的是后两份，
 * 星芒进程继承来的可能是旧值，所以三份都要。只读，去重，认不出的写法不测。
 */
export function environmentProxyCandidates(scopes: {
  process: Readonly<Record<string, string | undefined>>
  user?: Partial<Record<StaleProxyVariableName, string>>
  machine?: Partial<Record<StaleProxyVariableName, string>>
}): string[] {
  const found: string[] = []
  for (const scope of [scopes.process, scopes.user ?? {}, scopes.machine ?? {}]) {
    for (const name of proxyVariableOrder) {
      const value = proxyValue(scope, name)
      if (!value) continue
      try {
        const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`)
        if (!['http:', 'https:', 'socks:', 'socks4:', 'socks5:'].includes(url.protocol)) continue
        const normalized = `${url.protocol}//${url.host}`
        if (!found.includes(normalized)) found.push(normalized)
      } catch {
        // 写错了的不测，诊断页另有一项专门看它。
      }
    }
  }
  return found
}

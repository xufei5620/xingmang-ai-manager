const fs = require('node:fs/promises')
const path = require('node:path')
const https = require('node:https')
const { performance } = require('node:perf_hooks')
const { SOURCES, OFFICIAL_HOSTS, parseDebianPackages } = require('./sync-claude-official-cos.cjs')
const { readClaudeIndex, safeSyncFailure } = require('./public-entry-http.cjs')
const REDIRECTS = new Set([301, 302, 303, 307, 308])
const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'])

function hostLabel(host) {
  return /^[a-z0-9.-]{1,253}$/.test(host) ? host.slice(0, 96) : 'unverified-host'
}

function safeAddress(url) {
  const known = OFFICIAL_HOSTS.includes(url.hostname)
  const allowedPath = url.hostname === 'claude.ai' ? url.pathname.startsWith('/api/desktop/')
    : url.hostname === 'downloads.claude.ai' && /^\/(?:claude-desktop\/|releases\/)/.test(url.pathname)
  const valid = known && allowedPath && url.protocol === 'https:' && !url.port && !url.username && !url.password && !url.hash
  return { valid, address: { host: hostLabel(url.hostname), ...(valid ? { path: url.pathname.slice(0, 512) } : {}), queryPresent: Boolean(url.search) } }
}

function safePublicPackagePath(url) {
  const value = url.pathname
  return value.length <= 512 && /^\/[A-Za-z0-9._/-]+\.(?:msix|dmg|pkg|exe|zip)$/i.test(value)
    && /\/claude[^/]*\.(?:msix|dmg|pkg|exe|zip)$/i.test(value) ? value : undefined
}

function responseHead(url, timeoutMs, requestImpl = https.request, method = 'HEAD') {
  if (!safeAddress(url).valid) throw new Error('Unsupported Claude source scope')
  if (!['HEAD', 'GET'].includes(method)) throw new Error('Unsupported read-only method')
  return new Promise((resolve) => {
    let request
    let settled = false
    function finish(value) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (request) request.destroy()
      resolve(value)
    }
    const timer = setTimeout(() => finish({ status: null, code: 'response-header-timeout' }), timeoutMs)
    try {
      request = requestImpl(url, { method, headers: { 'accept-encoding': 'identity', 'user-agent': 'xingmang-official-offline-sync/1' }, agent: false, maxHeaderSize: 16384 }, (response) => {
        const location = response.headers?.location
        const length = response.headers?.['content-length']
        const status = Number.isInteger(response.statusCode) ? response.statusCode : null
        response.destroy()
        finish({ status, code: status >= 200 && status < 300 ? 'head-ok' : 'http-status',
          location: typeof location === 'string' && location.length <= 4096 ? location : null,
          bytes: typeof length === 'string' && /^[0-9]+$/.test(length) && Number.isSafeInteger(Number(length)) && Number(length) <= 2 * 1024 * 1024 * 1024 ? Number(length) : null })
      })
      request.on('error', (error) => finish({ status: null, code: NETWORK_CODES.has(error.code) ? error.code : 'network-request-failed' }))
      request.end()
    } catch { finish({ status: null, code: 'network-request-failed' }) }
  })
}

async function probeClaudeSources({ requestImpl, report = function () {}, metadata = true, method = 'HEAD' } = {}) {
  const rows = []
  function record(row) { rows.push(row); report(row) }
  for (const [label, source] of Object.entries(SOURCES)) {
    if (source.metadataUrl) {
      if (!metadata) continue
      let result
      try {
        result = await readClaudeIndex(label, requestImpl)
        record({ label, phase: 'apt-get', status: result.status, code: 'get-ok', bytes: result.bytes,
          host: 'downloads.claude.ai', path: new URL(source.metadataUrl).pathname, queryPresent: false })
      } catch (error) {
        const diagnostic = safeSyncFailure(error)
        record({ label, phase: 'apt-get', status: diagnostic.status ?? null, code: diagnostic.transportCode || diagnostic.code,
          bytes: Math.min(diagnostic.transferredBytes || 0, 1024 * 1024), host: 'downloads.claude.ai', queryPresent: false })
        continue
      }
      try {
        const parsed = parseDebianPackages(result.body.toString('utf8'), source.packageArchitecture)
        record({ label, phase: 'apt-parse', status: result.status, code: 'parse-ok', bytes: result.bytes,
          packageSize: parsed.bytes, sha256: parsed.expectedSha256, version: parsed.version })
      } catch { record({ label, phase: 'apt-parse', status: result.status, code: 'parse-failed', bytes: result.bytes }) }
      continue
    }
    let current = new URL(source.requestUrl)
    const visited = new Set()
    const started = performance.now()
    for (let hop = 0; hop <= 3; hop += 1) {
      const address = safeAddress(current)
      if (!address.valid) { record({ label, phase: 'redirect-stop', status: null, code: 'unverified-host-or-path', ...address.address }); break }
      if (visited.has(current.href) || performance.now() - started >= 90000) { record({ label, phase: 'redirect-stop', status: null, code: 'loop-or-deadline', ...address.address }); break }
      visited.add(current.href)
      const response = await responseHead(current, Math.max(1, Math.min(30000, 90000 - Math.round(performance.now() - started))), requestImpl, method)
      const priorHeadStatus = source.platform === 'windows' ? 405 : 403
      record({ label, phase: method === 'GET' ? 'get-response-headers' : 'head', status: response.status, code: response.code,
        declaredBytesSafe: response.bytes ?? null, redirectCount: hop, safeResolvedHost: address.address.host,
        ...(method === 'GET' && hop === 0 ? { priorHeadStatus, sameAsPriorHead: response.status === priorHeadStatus } : {}),
        locationPresent: Boolean(response.location), ...address.address })
      if (!REDIRECTS.has(response.status)) break
      if (!response.location || hop === 3) { record({ label, phase: 'redirect-stop', status: response.status, code: 'missing-location-or-hop-limit' }); break }
      try {
        const next = new URL(response.location, current)
        const target = safeAddress(next)
        if (!target.valid) {
          record({ label, phase: 'redirect-stop', status: response.status, code: 'unverified-host-or-path', redirectCount: hop + 1,
            safeResolvedHost: target.address.host, ...target.address,
            ...(safePublicPackagePath(next) ? { path: safePublicPackagePath(next) } : {}) })
          break
        }
        current = next
      } catch { record({ label, phase: 'redirect-stop', status: response.status, code: 'invalid-location' }); break }
    }
  }
  return rows
}

async function main() {
  if (process.argv.length !== 2) throw new Error('No runtime source arguments supported')
  const rows = await probeClaudeSources({ metadata: false, method: 'GET', report: (row) => console.log(JSON.stringify(row)) })
  const root = await fs.realpath(process.env.RUNNER_TEMP)
  const output = path.resolve(process.env.PUBLIC_PROBE_OUTPUT)
  if (await fs.realpath(path.dirname(output)) !== root || !/^claude-public-source-probe-(?:Windows|Linux)\.json$/.test(path.basename(output))) throw new Error('Unsupported evidence scope')
  await fs.writeFile(path.join(root, path.basename(output)), `${JSON.stringify(rows, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
}

if (require.main === module) main().catch(() => {
  console.log(JSON.stringify({ label: 'probe', phase: 'setup', status: null, code: 'probe-setup-failed', bytes: 0 }))
  process.exitCode = 1
})

module.exports = { probeClaudeSources, safeAddress }

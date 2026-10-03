const fs = require('node:fs/promises')
const path = require('node:path')
const https = require('node:https')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { randomUUID } = require('node:crypto')

const CLIENT_VERSION = '2.19675.0'
const MAX_METADATA_BYTES = 1024 * 1024
const MAX_PACKAGE_BYTES = 2 * 1024 * 1024 * 1024
const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'])

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isSafeVersion(value) {
  return typeof value === 'string' && value.length <= 64 && /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(value)
    && value.split('.').every(function (part) { return Number.isSafeInteger(Number(part)) && Number(part) <= 65535 })
}

function hasBoundedShape(value) {
  const pending = [{ value, depth: 1 }]
  const seen = new Set()
  while (pending.length) {
    const item = pending.pop()
    if (!item.value || typeof item.value !== 'object') continue
    if (item.depth > 4 || seen.has(item.value) || seen.size >= 256) return false
    seen.add(item.value)
    if (Array.isArray(item.value) && item.value.length > 16 || Object.keys(item.value).length > 32) return false
    for (const child of Object.values(item.value)) {
      if (child && typeof child === 'object') pending.push({ value: child, depth: item.depth + 1 })
    }
  }
  return true
}

function safePayload(value) {
  if (!isRecord(value)) return { schema: 'other-json' }
  const result = { schema: 'other-json-object', fields: {
    url: Object.hasOwn(value, 'url'), version: Object.hasOwn(value, 'version'), currentRelease: Object.hasOwn(value, 'currentRelease'),
    name: Object.hasOwn(value, 'name'), pubDate: Object.hasOwn(value, 'pub_date'), size: Object.hasOwn(value, 'size'),
    sha256: Object.hasOwn(value, 'sha256'), delta: Object.hasOwn(value, 'delta'), releases: Object.hasOwn(value, 'releases'),
  } }
  for (const [key, target] of [['version', 'claimedVersion'], ['currentRelease', 'claimedCurrentRelease'], ['name', 'claimedNameVersion']]) {
    if (isSafeVersion(value[key])) result[target] = value[key]
  }
  if (typeof value.name === 'string' && value.name.length <= 64 && /^(?:Claude(?: Desktop)? )?(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(value.name)) result.claimedName = value.name
  if (typeof value.pub_date === 'string' && value.pub_date.length <= 40
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value.pub_date)
    && Number.isFinite(Date.parse(value.pub_date))) result.claimedPubDate = value.pub_date
  if (Number.isSafeInteger(value.size) && value.size > 0 && value.size <= MAX_PACKAGE_BYTES) result.claimedSize = value.size
  if (typeof value.sha256 === 'string' && /^[a-fA-F0-9]{64}$/.test(value.sha256)) result.claimedSha256 = value.sha256.toLowerCase()
  if (typeof value.url === 'string' && value.url.length <= 4096) {
    result.schema = 'squirrel-server-json-unverified-url'
    try {
      const url = new URL(value.url)
      if (url.href === value.url && url.protocol === 'https:' && url.hostname === 'downloads.claude.ai' && !url.port && !url.username && !url.password && !url.hash
        && url.pathname.length <= 512 && /^\/releases\/[A-Za-z0-9._/-]+\.zip$/.test(url.pathname)) {
        result.schema = 'squirrel-server-json'
        result.payload = { host: url.hostname, path: url.pathname, queryPresent: Boolean(url.search), eligibleAsPersistentSource: !url.search }
      }
    } catch {}
  }
  return result
}

function safeMetadata(value) {
  if (!hasBoundedShape(value)) return { schema: 'metadata-shape-rejected' }
  const result = safePayload(value)
  if (!isRecord(value) || !Object.hasOwn(value, 'releases')) return result
  // The official static Squirrel schema uses only the entry whose version is
  // currentRelease. Other rows and free-form release notes stay unreported.
  if (!isSafeVersion(value.currentRelease) || !Array.isArray(value.releases)
    || value.releases.some(function (entry) { return !isRecord(entry) || !isSafeVersion(entry.version) || !isRecord(entry.updateTo) })) return { ...result, schema: 'squirrel-static-json-invalid-releases' }
  const selected = value.releases.filter(function (entry) { return entry.version === value.currentRelease })
  const summary = { ...result, schema: 'squirrel-static-json', releaseCount: value.releases.length, matchingReleaseCount: selected.length }
  if (selected.length !== 1) return { ...summary, schema: selected.length === 0 ? 'squirrel-static-json-missing-selection' : 'squirrel-static-json-ambiguous-selection' }
  const release = selected[0]
  const payload = safePayload(release.updateTo)
  summary.selectedRelease = { metadataPath: 'releases[].updateTo', outerClaimedVersion: release.version, ...payload }
  if (Object.hasOwn(release.updateTo, 'version') && release.updateTo.version !== release.version) summary.schema = 'squirrel-static-json-version-mismatch'
  else if (payload.schema !== 'squirrel-server-json') summary.schema = 'squirrel-static-json-unverified-payload'
  return summary
}

function readMetadataOnce(url, requestImpl, deadlineMs) {
  return new Promise(function (resolve) {
    let request
    let response
    let settled = false
    let bodyTimer
    let bytes = 0
    function finish(result) {
      if (settled) return
      settled = true
      clearTimeout(headerTimer)
      clearTimeout(bodyTimer)
      if (response) response.destroy()
      if (request) request.destroy()
      resolve({ ...result, metadataBytesConsumed: bytes })
    }
    const headerTimer = setTimeout(function () { finish({ status: null, code: 'response-header-timeout' }) }, deadlineMs)
    try {
      request = requestImpl(url, { method: 'GET', headers: {
        accept: 'application/json', 'accept-encoding': 'identity', 'user-agent': 'xingmang-official-offline-sync/1',
      }, agent: false, maxHeaderSize: 16384 }, function (incoming) {
        response = incoming
        clearTimeout(headerTimer)
        const status = Number.isInteger(response.statusCode) ? response.statusCode : null
        const headers = Object.fromEntries(Object.entries(response.headers || {}).map(function ([key, value]) { return [key.toLowerCase(), value] }))
        const fields = { location: Object.hasOwn(headers, 'location'), wwwAuthenticate: Object.hasOwn(headers, 'www-authenticate'),
          proxyAuthenticate: Object.hasOwn(headers, 'proxy-authenticate'), refresh: Object.hasOwn(headers, 'refresh'), cfMitigated: Object.hasOwn(headers, 'cf-mitigated') }
        const cfMitigatedClass = !fields.cfMitigated ? 'absent' : typeof headers['cf-mitigated'] !== 'string' ? 'invalid'
          : headers['cf-mitigated'].trim().toLowerCase() === 'challenge' ? 'challenge' : 'other'
        const base = { status, responseFields: fields, cfMitigatedClass }
        if (fields.cfMitigated || fields.wwwAuthenticate || fields.proxyAuthenticate || fields.refresh) return finish({ ...base, code: fields.cfMitigated ? 'challenge' : 'authentication-or-refresh' })
        if (status === 401) return finish({ ...base, code: 'unauthorized' })
        if (status === 204) return finish({ ...base, code: 'no-update', schema: 'no-update' })
        if (status !== 200 || fields.location) return finish({ ...base, code: status >= 300 && status < 400 || fields.location ? 'redirect-rejected' : 'http-status' })
        if (headers['content-encoding'] && headers['content-encoding'] !== 'identity') return finish({ ...base, code: 'unsupported-content-encoding' })
        if (headers['content-length'] !== undefined && (typeof headers['content-length'] !== 'string' || !/^[0-9]+$/.test(headers['content-length'])
          || !Number.isSafeInteger(Number(headers['content-length'])) || Number(headers['content-length']) > MAX_METADATA_BYTES)) return finish({ ...base, code: 'invalid-or-overlarge-declared-body' })
        const chunks = []
        bodyTimer = setTimeout(function () { finish({ ...base, code: 'metadata-body-timeout' }) }, deadlineMs)
        response.on('data', function (chunk) {
          if (settled) return
          bytes += chunk.length
          if (bytes > MAX_METADATA_BYTES) return finish({ ...base, code: 'metadata-body-too-large' })
          chunks.push(chunk)
        })
        response.on('error', function () { finish({ ...base, code: 'metadata-response-failed' }) })
        response.on('aborted', function () { finish({ ...base, code: 'metadata-response-aborted' }) })
        response.on('end', function () {
          if (response.complete !== true) return finish({ ...base, code: 'metadata-response-incomplete' })
          try { finish({ ...base, code: 'metadata-json', ...safeMetadata(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }) }
          catch { finish({ ...base, code: 'metadata-not-json', schema: 'non-json' }) }
        })
      })
      request.on('error', function (error) { finish({ status: null, code: NETWORK_CODES.has(error.code) ? error.code : 'network-request-failed' }) })
      if (settled) request.destroy()
      else request.end()
    } catch { finish({ status: null, code: 'network-request-failed' }) }
  })
}

async function probeMacUpdate({ platform = process.platform, architecture = process.arch, requestImpl = https.request,
  run = promisify(execFile), createId = randomUUID, deadlineMs = 30000 } = {}) {
  if (platform !== 'darwin' || !['arm64', 'x64'].includes(architecture) || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 30000) throw new Error('Unsupported native metadata probe scope')
  const system = await run('/usr/bin/sw_vers', ['-productVersion'], { env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C' }, timeout: 5000, maxBuffer: 256 })
  const osVersion = system.stdout.trim()
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(osVersion) || osVersion.length > 32) throw new Error('Unsupported native OS version')
  const installId = createId()
  if (typeof installId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(installId)) throw new Error('Unsupported ephemeral installation identity')
  const url = new URL(`https://api.anthropic.com/api/desktop/darwin/${architecture}/squirrel/update`)
  // Exact official lUt parameter names and order, with this test installation's
  // own ephemeral UUID. No existing user identity or policy is consulted.
  url.search = `device_id=${encodeURIComponent(installId)}&version=${encodeURIComponent(CLIENT_VERSION)}&os_version=${encodeURIComponent(osVersion)}`
  return { label: 'macos-official-update', phase: 'get-update-metadata', method: 'GET', host: url.hostname, path: url.pathname,
    architecture, clientVersion: CLIENT_VERSION, osVersion, claimScope: 'public-metadata-not-file-verification',
    ...await readMetadataOnce(url, requestImpl, deadlineMs),
  }
}

async function main() {
  if (process.argv.length !== 2) throw new Error('No runtime source arguments supported')
  const row = await probeMacUpdate()
  console.log(JSON.stringify(row))
  const root = await fs.realpath(process.env.RUNNER_TEMP)
  const output = path.resolve(process.env.PUBLIC_PROBE_OUTPUT)
  if (await fs.realpath(path.dirname(output)) !== root || path.basename(output) !== 'claude-mac-update-probe-macOS.json') throw new Error('Unsupported evidence scope')
  await fs.writeFile(path.join(root, path.basename(output)), `${JSON.stringify(row, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
}

if (require.main === module) main().catch(function () {
  console.log(JSON.stringify({ label: 'probe', phase: 'setup', status: null, code: 'probe-setup-failed', metadataBytesConsumed: 0 }))
  process.exitCode = 1
})

module.exports = { probeMacUpdate, safeMetadata }

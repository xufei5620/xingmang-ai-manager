const fs = require('node:fs/promises')
const path = require('node:path')
const https = require('node:https')

const TARGETS = Object.freeze([
  Object.freeze({ label: 'macos-dmg-universal', url: 'https://claude.ai/api/desktop/darwin/universal/dmg/latest/redirect' }),
  Object.freeze({ label: 'macos-pkg-universal', url: 'https://claude.ai/api/desktop/darwin/universal/pkg/latest/redirect' }),
])
const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'])

function summarizeHeaders(headers) {
  const entries = new Map(Object.entries(headers || {}).map(function ([name, value]) { return [name.toLowerCase(), value] }))
  const value = entries.get('cf-mitigated')
  return {
    fields: {
      location: entries.has('location'),
      wwwAuthenticate: entries.has('www-authenticate'),
      proxyAuthenticate: entries.has('proxy-authenticate'),
      refresh: entries.has('refresh'),
      cfMitigated: entries.has('cf-mitigated'),
    },
    cfMitigatedClass: !entries.has('cf-mitigated') ? 'absent' : typeof value !== 'string' ? 'invalid'
      : value.trim().toLowerCase() === 'challenge' ? 'challenge' : 'other',
  }
}

function inspectInitialResponse(target, requestImpl, timeoutMs) {
  return new Promise(function (resolve) {
    let request
    let settled = false
    function finish(result, response) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (response) response.destroy()
      if (request) request.destroy()
      resolve({ label: target.label, phase: 'get-initial-response-headers', method: 'GET', ...result, bodyBytesConsumed: 0 })
    }
    const timer = setTimeout(function () { finish({ status: null, code: 'response-header-timeout' }) }, timeoutMs)
    try {
      request = requestImpl(new URL(target.url), { method: 'GET', headers: {
        'accept-encoding': 'identity', 'user-agent': 'xingmang-official-offline-sync/1',
      }, agent: false, maxHeaderSize: 16384 }, function (response) {
        const status = Number.isInteger(response.statusCode) && response.statusCode >= 100 && response.statusCode <= 599 ? response.statusCode : null
        finish({ status, code: status === null ? 'invalid-status' : 'http-status', ...summarizeHeaders(response.headers) }, response)
      })
      request.on('error', function (error) { finish({ status: null, code: NETWORK_CODES.has(error.code) ? error.code : 'network-request-failed' }) })
      if (settled) request.destroy()
      else request.end()
    } catch { finish({ status: null, code: 'network-request-failed' }) }
  })
}

async function probeMacInitialHeaders({ requestImpl = https.request, timeoutMs = 30000, report = function () {} } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('Unsupported probe deadline')
  const rows = []
  for (const target of TARGETS) {
    const row = await inspectInitialResponse(target, requestImpl, timeoutMs)
    rows.push(row)
    report(row)
  }
  return rows
}

async function main() {
  if (process.argv.length !== 2) throw new Error('No runtime source arguments supported')
  const rows = await probeMacInitialHeaders({ report: function (row) { console.log(JSON.stringify(row)) } })
  const root = await fs.realpath(process.env.RUNNER_TEMP)
  const output = path.resolve(process.env.PUBLIC_PROBE_OUTPUT)
  if (await fs.realpath(path.dirname(output)) !== root || path.basename(output) !== 'claude-mac-response-probe-Linux.json') throw new Error('Unsupported evidence scope')
  await fs.writeFile(path.join(root, path.basename(output)), `${JSON.stringify(rows, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
}

if (require.main === module) main().catch(function () {
  console.log(JSON.stringify({ label: 'probe', phase: 'setup', status: null, code: 'probe-setup-failed', bodyBytesConsumed: 0 }))
  process.exitCode = 1
})

module.exports = { probeMacInitialHeaders, summarizeHeaders }

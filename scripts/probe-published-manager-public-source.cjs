const fs = require('node:fs/promises')
const path = require('node:path')
const https = require('node:https')
const { safeManagerSyncFailure } = require('./cos-manager-sync-diagnostics.cjs')
const common = require('./cos-sync-utils.cjs')
const { syncPublishedManagerRelease } = require('./sync-published-manager-cos.cjs')
const hosts = new Set(['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'])
const rows = []
let stage = 'setup'
let verified = 0
let stopped = false
let forbidden = false
function deny() { forbidden = true; throw new Error('PUBLIC_SOURCE_PROBE_FORBIDDEN') }
function requestImpl(address, options, callback) {
 let url
 try { url = new URL(address) } catch { return deny() }
 const method = options.method || 'GET'
 const keys = Object.keys(options.headers || {}).map(key => key.toLowerCase())
 if (url.protocol !== 'https:' || !hosts.has(url.hostname) || !['HEAD', 'GET'].includes(method) || keys.includes('authorization') || keys.includes('cookie')) return deny()
 return https.request(url, options, response => {
  if (method === 'HEAD') record({ event: 'head-result', stage, method, status: Number.isInteger(response.statusCode) ? response.statusCode : null })
  callback(response)
 })
}
function record(row) { rows.push(row); console.log(JSON.stringify(row)) }
async function main() {
 if (process.platform !== 'linux' || process.argv.length !== 2) throw new Error('PUBLIC_SOURCE_PROBE_SCOPE')
 for (const name of ['readCosConfiguration', 'createCosStore', 'buildCosAuthorization', 'buildCosSigningMaterial']) common[name] = deny
 try {
  await syncPublishedManagerRelease({ tag: 'v0.2.14', utilities: common, requestImpl,
   onDiagnostic(event) {
    if (event.event === 'stage-start') stage = event.stage
    if (event.event === 'stage-complete' && event.stage === 'verify-github-installer') verified += 1
    record(event)
   },
   async sync(input) {
    if (input.version !== '0.2.14' || input.installersOnly !== true || verified !== 3) return deny()
    stopped = true
    throw new Error('PUBLIC_SOURCE_PROBE_END')
   },
  })
  deny()
 } catch (error) {
  const diagnostic = safeManagerSyncFailure(error)
  record({ event: 'probe-final', verifiedAssets: verified, publicationStubReached: stopped, forbiddenCallDetected: forbidden,
   outcome: stopped && !forbidden && diagnostic.stage === 'cos-manager-publication' && diagnostic.latestState === 'not-written-by-this-run' ? 'github-source-and-hash-verified-no-cos' : 'source-probe-failed', diagnostic })
 }
 if (!stopped || forbidden) process.exitCode = 1
 const root = await fs.realpath(process.env.RUNNER_TEMP)
 const output = path.resolve(process.env.PUBLIC_PROBE_OUTPUT)
 if (await fs.realpath(path.dirname(output)) !== root || path.basename(output) !== 'manager-github-public-source-Linux.json') throw new Error('PUBLIC_SOURCE_PROBE_OUTPUT')
 await fs.writeFile(output, JSON.stringify(rows, null, 2)+'\n', {flag:'wx',mode:0o600})
}
main().catch(() => { console.log(JSON.stringify({event:'probe-final',outcome:'setup-failed'}));process.exitCode=1 })

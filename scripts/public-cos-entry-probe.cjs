const fs = require('node:fs/promises')
const path = require('node:path')
const { RESOURCES, MAX_PUBLIC_BYTES, publicRequest, safeSyncFailure } = require('./public-entry-http.cjs')
const { validateWindowsMetadata, parseMacAppcast } = require('./sync-chatgpt-official-cos.cjs')

function parsePublicDocument(kind, body) {
  const text = body.toString('utf8')
  if (kind === 'mac-arm64' || kind === 'mac-x64') {
    parseMacAppcast(text, kind === 'mac-arm64' ? 'arm64' : 'x64')
    return true
  }
  if (kind === 'license-xml') {
    return !/<!DOCTYPE|<!ENTITY/i.test(text)
      && /<(?:[A-Za-z_][\w.-]*:)?License\b/.test(text)
      && text.includes('urn:schemas-microsoft-com:windows:store:licensing:ls')
      && text.includes('9PLM9XGG6VKS')
      && text.toLowerCase().includes('openai.codex_2p2nqsd0c76g0')
  }
  const value = JSON.parse(text)
  if (kind === 'windows-metadata') { validateWindowsMetadata(value); return true }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1) return false
  if (kind === 'manager-index') return value.product === 'xingmang-ai-manager' && Array.isArray(value.files)
  if (kind === 'claude-index') return value.product === 'claude-desktop' && Array.isArray(value.files)
  return kind === 'codex-index' && value.product === 'chatgpt' && value.platforms
    && typeof value.platforms === 'object' && !Array.isArray(value.platforms)
}

function failureRow(label, phase, error) {
  const diagnostic = safeSyncFailure(error)
  return {
    label, phase,
    status: diagnostic.status ?? null,
    code: diagnostic.transportCode || diagnostic.code,
    bytes: Math.min(diagnostic.transferredBytes || 0, MAX_PUBLIC_BYTES),
  }
}

async function probePublicEntries({ requestImpl, report = function () {} } = {}) {
  const rows = []
  function record(row) {
    rows.push(row)
    report(row)
  }
  for (const resource of RESOURCES) {
    // HEAD and GET are independent: a provider may refuse one method while
    // allowing the other. Neither request carries authentication or cookies.
    try {
      const head = await publicRequest(resource.label, 'head', requestImpl)
      record({ label: resource.label, phase: 'head', status: head.status, code: 'ok', bytes: head.bytes ?? 0 })
    } catch (error) { record(failureRow(resource.label, 'head', error)) }
    let downloaded
    try {
      downloaded = await publicRequest(resource.label, 'get', requestImpl)
      record({ label: resource.label, phase: 'get', status: downloaded.status, code: 'ok', bytes: downloaded.bytes })
    } catch (error) { record(failureRow(resource.label, 'get', error)); continue }
    let parsed = false
    try { parsed = Boolean(parsePublicDocument(resource.kind, downloaded.body)) } catch {}
    record({ label: resource.label, phase: 'parse', status: downloaded.status, code: parsed ? 'parse-ok' : 'parse-failed', bytes: downloaded.bytes })
  }
  return rows
}

async function writeEvidence(rows, env) {
  if (!env.PUBLIC_PROBE_OUTPUT) return
  if (!env.RUNNER_TEMP) throw new Error('Evidence output requires the runner temp directory')
  const root = await fs.realpath(env.RUNNER_TEMP)
  const output = path.resolve(env.PUBLIC_PROBE_OUTPUT)
  const parent = await fs.realpath(path.dirname(output))
  if (parent !== root || !/^cos-public-entry-probe-(?:Windows|Linux)\.json$/.test(path.basename(output))) {
    throw new Error('Evidence output is outside the fixed runner temp scope')
  }
  await fs.writeFile(path.join(parent, path.basename(output)), `${JSON.stringify(rows, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
}

async function main() {
  if (process.argv.length !== 2) throw new Error('The public probe accepts no runtime source arguments')
  const rows = await probePublicEntries({ report: function (row) { console.log(JSON.stringify(row)) } })
  await writeEvidence(rows, process.env)
}

if (require.main === module) {
  main().catch(function () {
    console.log(JSON.stringify({ label: 'probe', phase: 'setup', status: null, code: 'probe-setup-failed', bytes: 0 }))
    process.exitCode = 1
  })
}

module.exports = { probePublicEntries, parsePublicDocument, writeEvidence }

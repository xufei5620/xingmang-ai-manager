const fs = require('node:fs')
const { execFileSync } = require('node:child_process')

function requiresCodeChecks(files) {
  const documentation = new Set(['README.md', 'CHANGELOG.md', 'HANDOFF.md', 'MAC_SOURCE_README.md', 'AGENTS.md', 'CLAUDE.md', 'LICENSE'])
  return files.some((file) => {
    // This Markdown ledger is validated against the shipped canvas assets.
    if (file === 'docs/CANVAS-THIRD-PARTY.md') return true
    return !(documentation.has(file) || /^docs\/.+\.md$/.test(file))
  })
}

// The relay probe answers one question: does the version this list pins still
// work against our own relay? Only a change to the list (or to the document
// that explains how to move it) can change that answer, so nothing else is
// worth a real request against production.
const cliVersionListFiles = new Set(['electron/cli-verified-versions.ts', 'docs/CLI-VERIFIED-VERSIONS.md'])

function touchesCliVersionList(files) {
  return files.some((file) => cliVersionListFiles.has(file))
}

function changedFiles(event, eventName, git = execFileSync) {
  const base = eventName === 'pull_request' ? event.pull_request?.base?.sha : event.before
  const head = eventName === 'pull_request' ? event.pull_request?.head?.sha : event.after
  if (![base, head].every((value) => typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value)) || /^0+$/.test(base)) return null
  return git('git', ['diff', '--name-only', '-z', base, head, '--'], { encoding: 'utf8' }).split('\0').filter(Boolean)
}

if (require.main === module) {
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
  const files = changedFiles(event, process.env.GITHUB_EVENT_NAME)
  const code = files === null || requiresCodeChecks(files)
  // Both default to true when the revision range is unknown: a check that
  // cannot tell what changed has to assume the worst, not skip itself.
  const cliVersions = files === null || touchesCliVersionList(files)
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `code=${code}\ncliVersions=${cliVersions}\n`, 'utf8')
  console.log(code ? 'Code checks required' : 'Documentation-only change; build jobs will report skipped')
  console.log(cliVersions ? 'Verified-version list touched; the relay probe will run' : 'Verified-version list untouched; the relay probe will report skipped')
}

module.exports = { requiresCodeChecks, touchesCliVersionList, changedFiles }

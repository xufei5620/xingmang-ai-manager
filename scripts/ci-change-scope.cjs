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
  const from = eventName === 'pull_request' ? mergeBase(base, head, git) : base
  if (!from) return null
  return git('git', ['diff', '--name-only', '-z', from, head, '--'], { encoding: 'utf8' }).split('\0').filter(Boolean)
}

// A pull request's base.sha is the base branch's tip when the event fired, not
// the commit the branch left it at. Diffing the two tips directly also counted
// every commit the base had gained since, so a documentation-only pull request
// that was behind main ran the whole matrix, plus the relay probe against
// production whenever main had moved the verified-version list (#926). Measure
// from the merge base, the range GitHub itself shows as the pull request's diff.
// Without one the range is unknown, and an unknown range runs everything.
function mergeBase(base, head, git) {
  let value
  try {
    value = git('git', ['merge-base', base, head], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
  return /^[0-9a-f]{40}$/i.test(value) ? value : null
}

// A push to main stands in for every merge since the last main run that got to
// finish, but its `before` is only the commit right below this one. A burst of
// merges cancels every run except the newest, so a documentation-only merge
// that happened to land last would otherwise mark main green over code merges
// whose own runs were cancelled before they checked anything.
function requiresCodeChecksForEvent(eventName, files) {
  return eventName === 'push' || files === null || requiresCodeChecks(files)
}

if (require.main === module) {
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
  const files = changedFiles(event, process.env.GITHUB_EVENT_NAME)
  const code = requiresCodeChecksForEvent(process.env.GITHUB_EVENT_NAME, files)
  // Both default to true when the revision range is unknown: a check that
  // cannot tell what changed has to assume the worst, not skip itself.
  const cliVersions = files === null || touchesCliVersionList(files)
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `code=${code}\ncliVersions=${cliVersions}\n`, 'utf8')
  console.log(code ? 'Code checks required' : 'Documentation-only change; build jobs will report skipped')
  console.log(cliVersions ? 'Verified-version list touched; the relay probe will run' : 'Verified-version list untouched; the relay probe will report skipped')
}

module.exports = { requiresCodeChecks, requiresCodeChecksForEvent, touchesCliVersionList, changedFiles }

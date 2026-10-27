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

// macos-test builds both architectures and starts the Apple silicon package on
// every pull request that touches code. The other two macOS jobs answer
// questions only the packaging inputs can change: macos-intel starts the Intel
// package on an Intel Mac, and macos-release-rehearsal walks the release path
// (the identity found by name, one build per architecture merged into one, the
// private acceleration bundles). Each holds one of the few macOS runners the
// account gets at a time, so with two pull requests in flight the next one
// queued: from 2026-10-24 to 10-26 the slowest quarter of pull request runs
// took 41.9 minutes, against 14.0 for everything but the macOS jobs (G1). A
// pull request now runs those two only when it touches one of the inputs below,
// and every push to main still runs them.
//
// The files are what those jobs build and run with: the build configuration,
// the scripts they start and everything those load, the main-process modules
// the acceleration staging tool loads from dist-electron, and the jobs
// themselves. ci-workflow-config.test.cjs walks those imports and fails when a
// file they reach is missing here.
const macPackagingFiles = new Set([
  'package.json',
  'package-lock.json',
  '.nvmrc',
  'electron-builder.config.cjs',
  'e2e/macos-launch-smoke.mjs',
  'scripts/update-release-utils.cjs',
  'scripts/linux-artifact-names.cjs',
  'scripts/electron-fuse-hardening.cjs',
  'scripts/prepare-acceleration-bundle.cjs',
  'scripts/stage-acceleration-bundle.cjs',
  'electron/acceleration-binary.ts',
  'electron/acceleration-clash-config.ts',
  'electron/bounded-file.ts',
  'electron/darwin-path-trust.ts',
  'electron/input-guards.ts',
  'electron/linux-path-trust.ts',
  'electron/path-identity.ts',
  'electron/relocated-folders.ts',
  'electron/safe-local-data.ts',
  // A change to the jobs, to the release job the rehearsal mirrors, or to
  // this very decision has to be seen running before it merges.
  '.github/workflows/quality.yml',
  '.github/workflows/publish-release.yml',
  'scripts/ci-change-scope.cjs',
])

const macPackagingPatterns = [
  // Every macOS build, signing, keychain and artifact script.
  /^scripts\/[^/]*macos[^/]*$/,
  /^build\/entitlements\.mac/,
  // The system proxy helper, compiled once per architecture.
  /^native\//,
  /^bundled-acceleration\//,
]

function touchesMacPackaging(files) {
  return files.some((file) => macPackagingFiles.has(file) || macPackagingPatterns.some((pattern) => pattern.test(file)))
}

// main runs them on every push for the reason requiresCodeChecksForEvent gives
// below, and an unknown range runs everything.
function requiresMacPackagingChecksForEvent(eventName, files) {
  if (!requiresCodeChecksForEvent(eventName, files)) return false
  return eventName === 'push' || files === null || touchesMacPackaging(files)
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
  const macPackaging = requiresMacPackagingChecksForEvent(process.env.GITHUB_EVENT_NAME, files)
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `code=${code}\ncliVersions=${cliVersions}\nmacPackaging=${macPackaging}\n`, 'utf8')
  console.log(code ? 'Code checks required' : 'Documentation-only change; build jobs will report skipped')
  console.log(cliVersions ? 'Verified-version list touched; the relay probe will run' : 'Verified-version list untouched; the relay probe will report skipped')
  console.log(macPackaging ? 'macOS packaging checks required; macos-intel and macos-release-rehearsal will run' : 'macOS packaging inputs untouched; macos-intel and macos-release-rehearsal will report skipped')
}

module.exports = {
  requiresCodeChecks,
  requiresCodeChecksForEvent,
  touchesCliVersionList,
  touchesMacPackaging,
  requiresMacPackagingChecksForEvent,
  changedFiles,
}

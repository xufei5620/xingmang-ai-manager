const fs = require('node:fs')
const { execFileSync } = require('node:child_process')

function requiresCodeChecks(files) {
  const documentation = new Set(['README.md', 'CHANGELOG.md', 'HANDOFF.md', 'MAC_SOURCE_README.md', 'AGENTS.md', 'CLAUDE.md', 'LICENSE'])
  return files.some((file) => {
    // This Markdown ledger is validated against the shipped canvas assets.
    if (file === 'docs/CANVAS-THIRD-PARTY.md') return true
    // These two are read by scripts and checked line by line in test:scripts
    // (a trigger that no longer matches any file, a second rerun of the same
    // test within two weeks), so a change to them has to run that check.
    if (file === 'docs/RELIABILITY-CHECKLIST.md' || file === 'docs/CI-RERUN-LEDGER.md') return true
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
  // How electron-builder fetches and checks the Electron zips and its tools:
  // the checksum table the configuration loads, and the download patch that
  // npm ci applies (the coverage walk in ci-workflow-config.test.cjs follows
  // requires, so it reaches the first but not the postinstall patch).
  'scripts/electron-zip-checksums.cjs',
  'scripts/patch-builder-fetch-compat.cjs',
  'scripts/builder-fetch-compat.cjs',
  'e2e/macos-launch-smoke.mjs',
  // 两个作业真开打好的包之前先把正式环境的域名指回本机（2026-11-21），改了它要在这两个作业上再跑一遍。
  'scripts/ci-block-production-hosts.cjs',
  'scripts/update-release-utils.cjs',
  'scripts/release-copyright.cjs',
  'scripts/extract-release-notes.cjs',
  'scripts/linux-artifact-names.cjs',
  'scripts/linux-payload-modes.cjs',
  // 配置的 afterPack 从这里取 Windows 安装包顶层条目名单的写法（D05），Mac 那一支不调用它，但配置要加载它。
  'scripts/windows-installer-package-entries.cjs',
  'scripts/electron-fuse-hardening.cjs',
  // 第三方许可清单：配置从这里取文件名和 Mac 补许可文件的钩子，出包校验也读它（D97）。
  'scripts/third-party-notices.cjs',
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
  // The DMG window background (and its outlined hint text) the dmg target packs.
  /^build\/dmg-background/,
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

// The two installer smokes build a real package and install it on a fresh
// runner, so each costs the better part of an hour and one of them a macOS
// runner. They used to be workflows of their own, triggered by these same
// path lists, which quality-gate could not see: #1524 merged on 2026-10-28
// with macos-upgrade red (run 40730079976), because nothing required it
// (CI-6 in the 11-09 test and CI review). quality.yml now calls them as jobs
// and the gate requires them whenever this says they are due.
//
// The lists are the `paths` filters the two workflows had, moved here
// unchanged. Like those filters they answer for pull requests only: a push to
// main never ran them, and package-for-testing runs the upgrade smoke on the
// very packages a release ships.
const upgradeSmokeFiles = new Set([
  'electron/updater.ts',
  'electron/auto-update-install.ts',
  'electron/installed-release.ts',
  'electron/bootstrap/updates.ts',
  'electron/app-settings.ts',
  'electron-builder.config.cjs',
  'build/installer.nsh',
  'scripts/windows-installer-package-entries.cjs',
  'package.json',
  'package-lock.json',
  'scripts/upgrade-smoke.cjs',
  'scripts/upgrade-smoke-support.cjs',
  '.github/workflows/upgrade-smoke.yml',
])

const upgradeSmokePatterns = [/^electron\/update-[^/]*\.ts$/]

function touchesUpgradeSmoke(files) {
  return files.some((file) => upgradeSmokeFiles.has(file) || upgradeSmokePatterns.some((pattern) => pattern.test(file)))
}

const uninstallSmokeFiles = new Set([
  'build/installer.nsh',
  'electron-builder.config.cjs',
  'electron/platform/entry.ts',
  'electron/platform/windows-system-proxy.ts',
  'electron/platform/system-service.ts',
  'electron/login-launch.ts',
  'scripts/windows-acceleration-recovery.ps1',
  'scripts/windows-uninstall-cleanup-smoke.ps1',
  'scripts/windows-uninstall-shortcuts-smoke.ps1',
  'scripts/windows-install-directory-acl-smoke.ps1',
  'scripts/windows-file-association-smoke.ps1',
  'scripts/windows-upgrade-blocked-smoke.ps1',
  'scripts/windows-upgrade-user-files-smoke.ps1',
  'scripts/windows-installer-package-entries.cjs',
  '.github/workflows/windows-uninstall-smoke.yml',
])

const uninstallSmokePatterns = [/^electron\/uninstall-cleanup[^/]*\.ts$/]

function touchesUninstallSmoke(files) {
  return files.some((file) => uninstallSmokeFiles.has(file) || uninstallSmokePatterns.some((pattern) => pattern.test(file)))
}

// Only a pull request runs them, never where the code checks are skipped, and
// an unknown range on a pull request runs them as it runs everything else.
function requiresInstallerSmokeForEvent(eventName, files, touches) {
  if (eventName !== 'pull_request') return false
  if (!requiresCodeChecksForEvent(eventName, files)) return false
  return files === null || touches(files)
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
  const upgradeSmoke = requiresInstallerSmokeForEvent(process.env.GITHUB_EVENT_NAME, files, touchesUpgradeSmoke)
  const uninstallSmoke = requiresInstallerSmokeForEvent(process.env.GITHUB_EVENT_NAME, files, touchesUninstallSmoke)
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `code=${code}\ncliVersions=${cliVersions}\nmacPackaging=${macPackaging}\nupgradeSmoke=${upgradeSmoke}\nuninstallSmoke=${uninstallSmoke}\n`,
    'utf8',
  )
  console.log(code ? 'Code checks required' : 'Documentation-only change; build jobs will report skipped')
  console.log(cliVersions ? 'Verified-version list touched; the relay probe will run' : 'Verified-version list untouched; the relay probe will report skipped')
  console.log(macPackaging ? 'macOS packaging checks required; macos-intel and macos-release-rehearsal will run' : 'macOS packaging inputs untouched; macos-intel and macos-release-rehearsal will report skipped')
  console.log(upgradeSmoke ? 'Update path touched; the upgrade smoke will run and must pass' : 'Update path untouched; the upgrade smoke will report skipped')
  console.log(uninstallSmoke ? 'Installer path touched; the Windows uninstall smoke will run and must pass' : 'Installer path untouched; the Windows uninstall smoke will report skipped')
}

module.exports = {
  requiresCodeChecks,
  requiresCodeChecksForEvent,
  touchesCliVersionList,
  touchesMacPackaging,
  requiresMacPackagingChecksForEvent,
  touchesUpgradeSmoke,
  touchesUninstallSmoke,
  requiresInstallerSmokeForEvent,
  changedFiles,
}

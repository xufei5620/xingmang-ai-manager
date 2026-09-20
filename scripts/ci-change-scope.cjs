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
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `code=${code}\n`, 'utf8')
  console.log(code ? 'Code checks required' : 'Documentation-only change; build jobs will report skipped')
}

module.exports = { requiresCodeChecks, changedFiles }
